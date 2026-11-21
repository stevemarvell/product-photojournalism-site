import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// #336: a checkout that persists its token leaves it in .git/config, where
// any script from a pull request can read it. Every actions/checkout step
// must say `persist-credentials: false`. A checkout that cannot (the action
// does its own authentication) is listed in EXEMPT as "file:job-id:step index"
// with the reason beside it; none is exempt today.
const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const EXEMPT: string[] = [];

interface Checkout {
  where: string;
  persist: unknown;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
}

function checkouts(): Checkout[] {
  const found: Checkout[] = [];
  for (const file of workflowFiles()) {
    const doc = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as {
      jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
    } | null;
    if (!doc?.jobs || typeof doc.jobs !== 'object') {
      throw new Error(`${file} has no jobs: cannot check its checkouts`);
    }
    for (const [job, { steps = [] }] of Object.entries(doc.jobs)) {
      steps.forEach((step, i) => {
        if (step.uses?.startsWith('actions/checkout@')) {
          found.push({ where: `${file}:${job}:${i}`, persist: step.with?.['persist-credentials'] });
        }
      });
    }
  }
  return found;
}

describe('actions/checkout in workflows', () => {
  it('reads at least one workflow file', () => {
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  it('finds the ten checkouts, so the scan cannot pass by seeing none', () => {
    expect(checkouts()).toHaveLength(10);
  });

  it('every one sets persist-credentials: false', () => {
    const bad = checkouts()
      .filter((c) => c.persist !== false && !EXEMPT.includes(c.where))
      .map((c) => c.where);
    expect(bad).toEqual([]);
  });
});
