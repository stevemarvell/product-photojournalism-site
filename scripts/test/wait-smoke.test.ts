import { describe, expect, it } from 'vitest';
import type { Run, RunResult } from '../wait-checks.mjs';
import { INTERVAL_MS, SMOKE_ATTEMPTS, exitCode, judge, render, waitSmoke } from '../wait-smoke.mjs';

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });
const bad = (stderr: string): RunResult => ({ status: 1, stdout: '', stderr });

type Step = { runs?: { id: number; status: string; conclusion?: string | null }[]; fail?: boolean };

/** A fake `gh`: the merge commit is `merge99`; each attempt reads it, then lists the smoke runs for it. */
function fakeGh(script: Step[], merged = true) {
  const calls: string[][] = [];
  let attempt = 0;
  const run: Run = async (args) => {
    calls.push(args);
    if (args[1]!.endsWith('/pulls/7')) return ok(merged ? 'merge99\n' : '\n');
    const entry = script[Math.min(attempt++, script.length - 1)]!;
    if (entry.fail) return bad('HTTP 502');
    return ok(JSON.stringify({ workflow_runs: entry.runs ?? [] }));
  };
  return { run, calls };
}

function sleeper() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => void slept.push(ms), slept };
}

describe('the declared ceiling', () => {
  it('is 30 attempts of 30 seconds', () => {
    expect(SMOKE_ATTEMPTS).toBe(30);
    expect(INTERVAL_MS).toBe(30000);
  });
});

describe('judge', () => {
  it('is pending with no run, or a run not completed', () => {
    expect(judge([]).state).toBe('pending');
    expect(judge([{ id: 1, status: 'in_progress', conclusion: null }]).state).toBe('pending');
  });
  it('passes on success and fails on anything else', () => {
    expect(judge([{ id: 1, status: 'completed', conclusion: 'success' }])).toEqual({ state: 'pass', run: 1 });
    expect(judge([{ id: 2, status: 'completed', conclusion: 'cancelled' }])).toEqual({ state: 'fail', run: 2 });
  });
});

describe('waitSmoke', () => {
  it('prints pass for the merge commit and exits 0', async () => {
    const { run, calls } = fakeGh([{ runs: [{ id: 5, status: 'completed', conclusion: 'success' }] }]);
    const result = await waitSmoke(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('smoke: pass merge99 5');
    expect(exitCode(result)).toBe(0);
    expect(calls[1]![1]).toBe('repos/{owner}/{repo}/actions/workflows/smoke.yml/runs?head_sha=merge99');
  });

  it('prints fail and exits 1 when the run concludes in anything but success', async () => {
    const { run } = fakeGh([{ runs: [{ id: 6, status: 'completed', conclusion: 'failure' }] }]);
    const result = await waitSmoke(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('smoke: fail merge99 6');
    expect(exitCode(result)).toBe(1);
  });

  it('waits while the run is absent, then finds it', async () => {
    const { run } = fakeGh([
      { runs: [] },
      { runs: [{ id: 8, status: 'in_progress', conclusion: null }] },
      { runs: [{ id: 8, status: 'completed', conclusion: 'success' }] },
    ]);
    const { sleep, slept } = sleeper();
    const result = await waitSmoke(7, { gh: run, sleep });
    expect(result).toMatchObject({ state: 'pass', attempts: 3 });
    expect(slept).toEqual([INTERVAL_MS, INTERVAL_MS]);
  });

  it('counts a failed gh call as an attempt, then succeeds', async () => {
    const { run } = fakeGh([{ fail: true }, { runs: [{ id: 9, status: 'completed', conclusion: 'success' }] }]);
    const result = await waitSmoke(7, { gh: run, sleep: sleeper().sleep });
    expect(result).toMatchObject({ state: 'pass', attempts: 2 });
  });

  it('prints pending after 30 attempts and exits 2', async () => {
    const { run, calls } = fakeGh([{ runs: [] }]);
    const { sleep, slept } = sleeper();
    const result = await waitSmoke(7, { gh: run, sleep });
    expect(render(result)).toBe('smoke: pending after 30 attempts merge99');
    expect(exitCode(result)).toBe(2);
    expect(calls.filter((c) => c[1]!.includes('smoke.yml'))).toHaveLength(SMOKE_ATTEMPTS);
    expect(slept).toHaveLength(SMOKE_ATTEMPTS - 1);
  });

  it('exits 64 (not 1, which is a smoke failure) at once for a pull request that is not merged', async () => {
    const { run } = fakeGh([{ runs: [] }], false);
    const result = await waitSmoke(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('smoke: pull request #7 is not merged');
    expect(exitCode(result)).toBe(64);
    expect(exitCode(result)).not.toBe(1);
  });
});
