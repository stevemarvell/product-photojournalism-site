import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciDidNotRun } from '../ci-health.mjs';

// Job 132561360422 (a refused verify, 2026-11-14), exactly as the jobs
// endpoint returned it.
const refused = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/refused-job-2026-11-14.json'), 'utf8'),
);
// A real failure, fast, that had a runner.
const realFast = { ...refused, runner_id: 7, runner_name: 'GitHub Actions 7', steps: [{ name: 'verify' }] };
const success = { ...realFast, conclusion: 'success' };

describe('ciDidNotRun', () => {
  it('is true for a refused job', () => {
    expect(ciDidNotRun([refused, { ...refused }])).toBe(true);
  });
  it('is false when runner_id is absent, even with an empty runner_name', () => {
    expect(ciDidNotRun([{ status: 'completed', conclusion: 'failure', runner_name: '' }])).toBe(false);
  });
  it('is false when runner_id is null', () => {
    expect(ciDidNotRun([{ ...refused, runner_id: null }])).toBe(false);
  });
  it('is false for a fast real failure that had a runner', () => {
    expect(ciDidNotRun([realFast])).toBe(false);
  });
  it('is false for one refused plus one real failure', () => {
    expect(ciDidNotRun([refused, realFast])).toBe(false);
  });
  it('is false for a success', () => {
    expect(ciDidNotRun([success])).toBe(false);
  });
  it('is false for an empty or missing list', () => {
    expect(ciDidNotRun([])).toBe(false);
    expect(ciDidNotRun(null)).toBe(false);
  });
  it('is false for an unfinished job', () => {
    expect(ciDidNotRun([{ ...refused, status: 'in_progress', conclusion: null }])).toBe(false);
  });
});

describe('ci-health CLI', () => {
  const run = (input: string) =>
    spawnSync('node', [resolve(__dirname, '../ci-health.mjs')], { input, encoding: 'utf8', timeout: 20000 });

  it('prints true for refused jobs', { timeout: 30000 }, () => {
    const r = run(JSON.stringify([refused]));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });
  it('prints false for a real failure', { timeout: 30000 }, () => {
    const r = run(JSON.stringify([realFast]));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('false');
  });
  it('exits 2 with a message on unreadable input', { timeout: 30000 }, () => {
    const r = run('not json');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not JSON');
  });
});
