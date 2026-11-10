import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadManifest } from '../labels.mjs';

// The Actions-minutes cuts are about which events start which jobs, and a
// trigger that is silently wrong costs either money or a check that never runs.
// These parse the workflow files CI runs with a real YAML parser (YAML 1.2, so
// the `on:` key stays a string), so trigger types are read from structure
// whether written inline or as a list, and a missing key fails loudly.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const path = (name: string) => join(REPO_ROOT, '.github/workflows', name);

interface Workflow {
  on: Record<string, { types?: string[]; branches?: string[] } | null>;
  concurrency?: { group: string; 'cancel-in-progress': boolean | string };
  jobs: Record<string, { if?: string; needs?: string | string[]; permissions?: Record<string, string>; steps?: { name?: string; if?: string; uses?: string; run?: string }[] }>;
}

function load(name: string): Workflow {
  const doc = parse(readFileSync(path(name), 'utf8')) as Workflow;
  expect(doc.on, `${name} has an on: block`).toBeTypeOf('object');
  return doc;
}

/** The event types a trigger lists; throws if the trigger is absent or lists none. */
function types(wf: Workflow, event: string): string[] {
  const trigger = wf.on[event];
  const list = trigger?.types;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`no types listed under ${event}`);
  return list;
}

/**
 * Evaluate a `concurrency.group` / `cancel-in-progress` expression for a
 * given event, for the tiny subset of the expression language used there:
 * `${{ ... }}` holes made of ==, !=, &&, ||, !, parentheses, string literals
 * and the context values github.event.action / label.name / run_id / ref.
 */
interface Ctx {
  action?: string;
  label?: string;
  runId?: string;
  /** The `changes` object of an `edited` event: `{ body: {...} }` for a body edit, `{ title: {...} }` for a title edit. */
  changes?: Record<string, unknown>;
}

/** One expression (no `${{ }}`), evaluated with Actions' truthiness for objects and empty strings. */
function evaluateExpression(expr: string, ctx: Ctx): unknown {
  const values: Record<string, unknown> = {
    'github.event.action': ctx.action,
    'github.event.label.name': ctx.label,
    'github.event.changes.body': ctx.changes?.['body'],
    'github.run_id': ctx.runId ?? '999',
    'github.ref': 'refs/pull/1/merge',
    'github.event_name': 'pull_request',
  };
  const js = expr
    .replace(/github\.event\.action|github\.event\.label\.name|github\.event\.changes\.body|github\.run_id|github\.ref|github\.event_name/g, (m) => `V[${JSON.stringify(m)}]`)
    .replace(/(?<![=!<>])==(?!=)/g, '===')
    .replace(/!=(?!=)/g, '!==');
  if (/[^\w\s'"[\].\-&|!=(){},/]/.test(js)) throw new Error(`unexpected character in expression: ${expr}`);
  const format = (fmt: string, ...args: unknown[]) => fmt.replace(/\{(\d)\}/g, (_m, i: string) => String(args[Number(i)]));
  return new Function('V', 'format', `return (${js});`)(values, format);
}

/** A template with `${{ }}` holes, or a bare boolean, evaluated to a string. */
function evaluate(template: string | boolean, ctx: Ctx): string {
  if (typeof template === 'boolean') return String(template);
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, expr: string) => String(evaluateExpression(expr, ctx)));
}

/** Whether a job-level `if:` lets the job start. */
const jobRuns = (condition: string, ctx: Ctx) => Boolean(evaluateExpression(condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), ctx));

const group = (wf: Workflow, ctx: Ctx) => evaluate(wf.concurrency!.group, ctx);
const cancels = (wf: Workflow, ctx: Ctx) => evaluate(wf.concurrency!['cancel-in-progress'], ctx) === 'true';

describe('the types helper cannot pass vacuously', () => {
  it('reads inline and block lists alike, and throws on a trigger that lists nothing', () => {
    const inline = parse('on:\n  pull_request:\n    types: [opened, labeled]\n') as Workflow;
    const block = parse('on:\n  pull_request:\n    types:\n      - opened\n      - labeled\n') as Workflow;
    expect(types(inline, 'pull_request')).toEqual(['opened', 'labeled']);
    expect(types(block, 'pull_request')).toEqual(['opened', 'labeled']);
    expect(() => types(parse('on:\n  pull_request:\n') as Workflow, 'pull_request')).toThrow(/no types/);
    expect(() => types(inline, 'push')).toThrow(/no types/);
  });
});

describe('verify.yml', () => {
  const wf = load('verify.yml');

  it('runs on pull requests and by hand, and not on a push to develop', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
  });

  it('lists no types on pull_request, so it cannot run on `edited`', () => {
    expect(wf.on['pull_request']?.types).toBeUndefined();
  });
});

describe('smoke.yml', () => {
  it('still runs on every push to develop', () => {
    expect(load('smoke.yml').on['push']?.branches).toEqual(['develop']);
  });
});

describe('pr-checks.yml, the census and contention in one job', () => {
  const wf = load('pr-checks.yml');

  it('replaces the two workflows it folds, so neither also runs', () => {
    expect(existsSync(path('test-census.yml'))).toBe(false);
    expect(existsSync(path('contention.yml'))).toBe(false);
  });

  it('has exactly one job, so the two checks bill one minute', () => {
    expect(Object.keys(wf.jobs)).toHaveLength(1);
  });

  it('still re-runs on a body edit, which is how a Removes tests: line is read', () => {
    expect(types(wf, 'pull_request')).toEqual(
      expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited']),
    );
  });

  it('keeps the push to develop, the only thing that tells an open pull request a merge broke it', () => {
    expect(wf.on['push']?.branches).toEqual(['develop']);
  });

  it('runs the census on pull requests only, and the contention steps through a failed census, not on an edit', () => {
    const steps = Object.values(wf.jobs)[0]!.steps!;
    const byRun = (needle: string) => steps.find((s) => s.run?.includes(needle));
    expect(byRun('scripts/test-census.mjs')?.if).toBe("github.event_name == 'pull_request'");
    const contention = steps.filter((s) => s.run?.includes('pr-contention.mjs') || s.name === 'List the open pull requests');
    expect(contention).toHaveLength(3);
    for (const s of contention) expect(s.if, s.name).toBe("${{ !cancelled() && github.event.action != 'edited' }}");
  });

  it('puts an edit in a different concurrency group from a push, and keeps per-ref cancel for both', () => {
    const body = { action: 'edited', changes: { body: { from: 'old' } } };
    const edit = group(wf, body);
    const push = group(wf, { action: 'synchronize' });
    expect(edit).not.toBe(push);
    expect(group(wf, { action: 'opened' })).toBe(push);
    expect(group(wf, { ...body, runId: '5' })).toBe(edit);
    // A body that was empty before is `{ from: '' }`: still an object, still a body edit.
    expect(group(wf, { action: 'edited', changes: { body: { from: '' } } })).toBe(edit);
    expect(cancels(wf, body)).toBe(true);
    expect(cancels(wf, { action: 'synchronize' })).toBe(true);
  });

  it('starts a billable job for a body edit and every other event, and nothing for a title or base edit', () => {
    const condition = Object.values(wf.jobs)[0]!.if!;
    expect(condition).toBeTypeOf('string');
    expect(jobRuns(condition, { action: 'edited', changes: { body: { from: 'old' } } })).toBe(true);
    expect(jobRuns(condition, { action: 'edited', changes: { body: { from: '' } } })).toBe(true);
    expect(jobRuns(condition, { action: 'edited', changes: { title: { from: 'old' } } })).toBe(false);
    expect(jobRuns(condition, { action: 'edited', changes: { base: { ref: { from: 'main' } } } })).toBe(false);
    for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', undefined]) {
      expect(jobRuns(condition, { action }), String(action)).toBe(true);
    }
  });

  it('keeps a title edit out of the body edit group, so it cannot cancel a census in flight', () => {
    const bodyGroup = group(wf, { action: 'edited', changes: { body: { from: 'x' } }, runId: '1' });
    const title1 = group(wf, { action: 'edited', changes: { title: { from: 'x' } }, runId: '2' });
    const title2 = group(wf, { action: 'edited', changes: { title: { from: 'y' } }, runId: '3' });
    expect(title1).not.toBe(bodyGroup);
    expect(title1).not.toBe(title2);
  });

  it('can write comments and nothing wider than the old contention job', () => {
    expect(Object.values(wf.jobs)[0]!.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });
});

describe('claude-code-review.yml, once per pull request (cut 3)', () => {
  const wf = load('claude-code-review.yml');

  it('no longer re-runs on every push', () => {
    const t = types(wf, 'pull_request');
    expect(t).not.toContain('synchronize');
    expect(t).toEqual(expect.arrayContaining(['opened', 'reopened', 'ready_for_review', 'labeled']));
  });

  it('starts the scope job, and so the reviews, for the re-review label and no other', () => {
    expect(wf.jobs['scope']!.if).toBe("github.event.action != 'labeled' || github.event.label.name == 're-review'");
  });

  it('keeps both reviews behind scope, so a skipped scope skips them', () => {
    for (const name of ['code-review', 'security-review']) expect(wf.jobs[name]!.needs, name).toBe('scope');
  });

  it('queues re-review runs behind each other instead of cancelling', () => {
    const rr = { action: 'labeled', label: 're-review' };
    expect(cancels(wf, rr)).toBe(false);
    expect(group(wf, rr)).toBe(group(wf, { ...rr, runId: '12345' }));
  });

  it('keeps a ready_for_review run out of the re-review group, so it cannot cancel one', () => {
    const rr = { action: 'labeled', label: 're-review' };
    expect(group(wf, { action: 'ready_for_review' })).not.toBe(group(wf, rr));
    expect(cancels(wf, { action: 'ready_for_review' })).toBe(true);
    expect(group(wf, { action: 'opened' })).toBe(group(wf, { action: 'ready_for_review' }));
  });

  it('gives a run for some other label a group of its own, so it cancels nothing', () => {
    const a = group(wf, { action: 'labeled', label: 'high', runId: '1' });
    const b = group(wf, { action: 'labeled', label: 'high', runId: '2' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(group(wf, { action: 'opened' }));
    expect(a).not.toBe(group(wf, { action: 'labeled', label: 're-review' }));
  });

  it('removes the label at the end, after both reviews, whatever they concluded', () => {
    const clear = wf.jobs['clear-re-review']!;
    expect(clear.needs).toEqual(['scope', 'code-review', 'security-review']);
    expect(clear.if).toBe("always() && github.event.action == 'labeled' && github.event.label.name == 're-review'");
    const text = JSON.stringify(clear);
    expect(text).toContain('-X DELETE');
    expect(text).toContain('labels/re-review');
    // It writes labels only: no secret, no checkout of the pull request.
    expect(text).not.toContain('secrets.');
    expect(clear.steps!.some((s) => s.uses?.includes('actions/checkout'))).toBe(false);
  });

  it('names a label that labels.json defines, so scripts/labels.mjs creates it', () => {
    const label = loadManifest().find((l) => l.name === 're-review');
    expect(label).toBeDefined();
    expect(label!.description.length).toBeLessThanOrEqual(100);
  });
});
