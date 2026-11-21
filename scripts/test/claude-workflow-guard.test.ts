import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// On a public repository anyone can comment `@claude`. claude.yml's job holds
// CLAUDE_CODE_OAUTH_TOKEN and the Grafana credentials, so each trigger event it
// listens to must be gated on author_association in the job's `if:`. This
// parses the file CI runs; it does not copy its logic.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'claude.yml'), 'utf8');

interface Workflow {
  on: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { if?: string }>;
}

const ALLOWED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const GUARD_FIELD: Record<string, string> = {
  issue_comment: 'comment',
  pull_request_review_comment: 'comment',
  pull_request_review: 'review',
};

/** Split `text` on a top-level (parenthesis depth 0, outside quotes) operator. */
function splitTop(text: string, op: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && text.startsWith(op, i)) {
      parts.push(text.slice(from, i).trim());
      from = i + 2;
      i++;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

function stripOuterParens(text: string): string {
  const t = text.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') depth--;
    if (depth === 0) return t; // the first paren closes before the end: not one group
  }
  return t.slice(1, -1).trim();
}

/**
 * Problems with the allowlist itself, per job and event: each trigger branch
 * (an arm of the top-level `||`) must be one event, its conjuncts joined by
 * `&&` only (an `||` inside an arm makes the guard optional), and exactly one
 * conjunct must be `contains(fromJSON('[...]'), <that event's field>)` with
 * exactly OWNER, MEMBER, COLLABORATOR.
 */
function allowlistProblems(source: string): string[] {
  const wf = parse(source) as Workflow;
  const problems: string[] = [];
  for (const [name, job] of Object.entries(wf.jobs)) {
    const condition = String(job.if ?? '').replace(/\s+/g, ' ');
    const seen: string[] = [];
    for (const arm of splitTop(condition, '||')) {
      const body = stripOuterParens(arm);
      const event = /github\.event_name == '([a-z_]+)'/.exec(body)?.[1] ?? '?';
      const at = `${name}/${event}`;
      seen.push(event);
      if (splitTop(body, '||').length > 1) {
        problems.push(`${at}: an || arm inside the branch`);
        continue;
      }
      const guards = splitTop(body, '&&').filter((c) => c.includes('author_association'));
      const m = guards.length === 1
        ? /^contains\(fromJSON\('(\[[^']*\])'\), github\.event\.(comment|review)\.author_association\)$/.exec(guards[0] ?? '')
        : null;
      if (!m) {
        problems.push(`${at}: no single contains(fromJSON(list), author_association) conjunct`);
        continue;
      }
      if (JSON.stringify(JSON.parse(m[1] ?? '[]')) !== JSON.stringify(ALLOWED)) problems.push(`${at}: list is ${m[1]}`);
      if (m[2] !== GUARD_FIELD[event]) problems.push(`${at}: checks github.event.${m[2]}`);
    }
    for (const event of Object.keys(wf.on)) if (!seen.includes(event)) problems.push(`${name}/${event}: no branch`);
  }
  return problems;
}

/**
 * Problems with the concurrency group, read as an expression: it must be
 * `(<@claude in body> && <author in the list>) && format('{0}', <number>) ||
 * format('ignored-{0}', github.run_id)`, so an unguarded event lands in a group
 * of its own. Substring checks would pass `||` where `&&` belongs.
 */
function concurrencyProblems(source: string): string[] {
  const raw = String((parse(source) as Workflow).concurrency?.group ?? '').replace(/\s+/g, ' ');
  if (raw.includes('github.ref')) return ['keyed on github.ref: every issue comment shares one group'];
  const expr = /^claude-\$\{\{ (.*) \}\}$/.exec(raw)?.[1];
  if (!expr) return ['group is not claude-${{ expression }}'];
  const arms = splitTop(expr, '||');
  if (arms.length !== 2) return [`expression has ${arms.length} top-level || arms, not 2`];
  const [guarded, other] = arms as [string, string];
  const problems: string[] = [];
  if (other !== "format('ignored-{0}', github.run_id)") problems.push(`fallback arm is ${other}`);
  const [guard, key, ...extra] = splitTop(guarded, '&&');
  if (!guard || !key || extra.length) return [...problems, 'guarded arm is not (guard) && key'];
  if (key !== "format('{0}', github.event.issue.number || github.event.pull_request.number)")
    problems.push(`key is ${key}`);
  const [mention, assoc, ...more] = splitTop(stripOuterParens(guard), '&&');
  if (more.length || !mention || !assoc) return [...problems, 'guard is not <mention> && <association>'];
  if (mention !== "contains(github.event.comment.body || github.event.review.body, '@claude')")
    problems.push(`mention test is ${mention}`);
  const m = /^contains\(fromJSON\('(\[[^']*\])'\), github\.event\.comment\.author_association \|\| github\.event\.review\.author_association\)$/.exec(assoc);
  if (!m) problems.push(`association test is ${assoc}`);
  else if (JSON.stringify(JSON.parse(m[1] ?? '[]')) !== JSON.stringify(ALLOWED)) problems.push(`group's list is ${m[1]}`);
  return problems;
}

/** Every `job/event` whose `if:` does not check author_association for that event. */
function unguarded(source: string): string[] {
  const wf = parse(source) as Workflow;
  const events = Object.keys(wf.on);
  const bad: string[] = [];
  for (const [name, job] of Object.entries(wf.jobs)) {
    const condition = String(job.if ?? '');
    for (const event of events) {
      const marker = `github.event_name == '${event}'`;
      const at = condition.indexOf(marker);
      if (at < 0) {
        bad.push(`${name}/${event}`);
        continue;
      }
      const rest = condition.slice(at + marker.length);
      const next = rest.indexOf('github.event_name ==');
      const branch = next < 0 ? rest : rest.slice(0, next);
      if (!branch.includes('author_association')) bad.push(`${name}/${event}`);
    }
  }
  return bad;
}

describe('claude.yml author_association guard', () => {
  it('guards every trigger event of every job', () => {
    expect(unguarded(WORKFLOW)).toEqual([]);
  });

  it('is not vacuous: it checks the three comment and review events', () => {
    expect(Object.keys((parse(WORKFLOW) as Workflow).on).sort()).toEqual([
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
    ]);
  });

  it('fails when the guard is removed from one branch', () => {
    const mutated = WORKFLOW.replace(
      /contains\(fromJSON\([^\n]*github\.event\.review\.author_association\)(?=\n\s*\)\n\s*runs-on)/,
      'true',
    );
    expect(mutated).not.toBe(WORKFLOW);
    expect(unguarded(mutated)).toEqual(['claude/pull_request_review']);
  });

  it('fails when a job has no condition at all', () => {
    const mutated = WORKFLOW.replace(/\n {4}if: \|[\s\S]*?\n {4}runs-on:/, '\n    runs-on:');
    expect(mutated).not.toBe(WORKFLOW);
    expect(unguarded(mutated)).toHaveLength(3);
  });

  it('allows exactly OWNER, MEMBER and COLLABORATOR on every branch, joined by &&', () => {
    expect(allowlistProblems(WORKFLOW)).toEqual([]);
  });

  it('fails when NONE or CONTRIBUTOR joins the list', () => {
    for (const extra of ['NONE', 'CONTRIBUTOR']) {
      const mutated = WORKFLOW.replace(
        /\["OWNER", "MEMBER", "COLLABORATOR"\]'\), github\.event\.review/,
        `["OWNER", "MEMBER", "COLLABORATOR", "${extra}"]'), github.event.review`,
      );
      expect(mutated).not.toBe(WORKFLOW);
      expect(allowlistProblems(mutated)).toEqual([expect.stringContaining('pull_request_review: list is')]);
    }
  });

  it('fails when the guard is reachable through an || arm', () => {
    const mutated = WORKFLOW.replace(
      /(contains\(github\.event\.review\.body, '@claude'\)) &&/,
      '$1 ||',
    );
    expect(mutated).not.toBe(WORKFLOW);
    expect(allowlistProblems(mutated)).toEqual([expect.stringContaining('an || arm')]);
  });

  it('fails when a branch checks the wrong event field', () => {
    const mutated = WORKFLOW.replace(
      /(pull_request_review' &&[\s\S]*?)github\.event\.review\.author_association/,
      '$1github.event.comment.author_association',
    );
    expect(mutated).not.toBe(WORKFLOW);
    expect(allowlistProblems(mutated)).toEqual([expect.stringContaining('checks github.event.comment')]);
  });

  it('keys concurrency so an unguarded event cannot cancel a guarded run', () => {
    expect(concurrencyProblems(WORKFLOW)).toEqual([]);
    expect((parse(WORKFLOW) as Workflow).concurrency?.['cancel-in-progress']).toBe(true);
  });

  it('fails when concurrency goes back to one group per ref', () => {
    const mutated = WORKFLOW.replace(/group: >-[\s\S]*?\n {2}cancel-in-progress/, 'group: claude-${{ github.ref }}\n  cancel-in-progress');
    expect(mutated).not.toBe(WORKFLOW);
    expect(concurrencyProblems(mutated)).toContain('keyed on github.ref: every issue comment shares one group');
  });

  it('fails when the concurrency list drifts from the guard', () => {
    const mutated = WORKFLOW.replace(
      /(claude-\$\{\{[\s\S]*?)"COLLABORATOR"\]/,
      '$1"COLLABORATOR", "NONE"]',
    );
    expect(mutated).not.toBe(WORKFLOW);
    expect(concurrencyProblems(mutated)).toEqual([expect.stringContaining("group's list is")]);
  });

  it('fails when the group joins its tests with || instead of &&', () => {
    const mutated = WORKFLOW.replace("'@claude')\n    && contains(fromJSON", "'@claude')\n    || contains(fromJSON");
    expect(mutated).not.toBe(WORKFLOW);
    expect(concurrencyProblems(mutated)).not.toEqual([]);
  });

  it('fails when the key is no longer behind the guard', () => {
    const mutated = WORKFLOW.replace("review.author_association))\n    && format('{0}'", "review.author_association))\n    format('{0}'");
    expect(mutated).not.toBe(WORKFLOW);
    expect(concurrencyProblems(mutated)).not.toEqual([]);
  });
});
