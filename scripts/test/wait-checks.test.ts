import { describe, expect, it } from 'vitest';
import {
  CHECK_ATTEMPTS,
  INTERVAL_MS,
  MAX_NAME_LENGTH,
  exitCode,
  judge,
  render,
  waitChecks,
  type CheckRun,
  type Run,
  type RunResult,
} from '../wait-checks.mjs';

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });
const bad = (stderr: string): RunResult => ({ status: 1, stdout: '', stderr });
const done = (name: string, conclusion: string): CheckRun => ({ name, status: 'completed', conclusion });
const running = (name: string): CheckRun => ({ name, status: 'in_progress', conclusion: null });

/**
 * A fake `gh`: each attempt reads the head, then its check runs. `script` is
 * one entry per attempt: the head sha and the check runs (or a failure) for it.
 * The last entry repeats once the script runs out.
 */
function fakeGh(script: { sha: string; runs?: CheckRun[]; fail?: 'head' | 'runs' }[]) {
  const calls: string[][] = [];
  let attempt = 0;
  let step = 0;
  const run: Run = async (args) => {
    calls.push(args);
    const entry = script[Math.min(attempt, script.length - 1)]!;
    if (args[1]!.endsWith('/pulls/7')) {
      step = 1;
      return entry.fail === 'head' ? bad('boom') : ok(`${entry.sha}\n`);
    }
    expect(step).toBe(1);
    const asked = args[1]!.match(/commits\/(\w+)\/check-runs/)?.[1];
    attempt++;
    step = 0;
    if (entry.fail === 'runs') return bad('HTTP 502');
    return ok(JSON.stringify({ check_runs: entry.runs?.filter(() => asked === entry.sha) ?? [] }));
  };
  return { run, calls };
}

function sleeper() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => void slept.push(ms), slept };
}

describe('the declared ceiling', () => {
  it('is 40 attempts of 30 seconds', () => {
    expect(CHECK_ATTEMPTS).toBe(40);
    expect(INTERVAL_MS).toBe(30000);
  });
});

describe('judge', () => {
  it('counts success, skipped and neutral as pass', () => {
    expect(judge([done('a', 'success'), done('b', 'skipped'), done('c', 'neutral')])).toEqual({ state: 'pass', failed: [] });
  });
  it('names every completed run of any other conclusion', () => {
    const verdict = judge([done('a', 'success'), done('b', 'failure'), done('c', 'cancelled'), done('d', 'timed_out')]);
    expect(verdict).toEqual({ state: 'fail', failed: ['b', 'c', 'd'] });
  });
  it('treats an empty list as pending', () => {
    expect(judge([]).state).toBe('pending');
  });
  it('lets a pending run outrank a failed one', () => {
    expect(judge([done('a', 'failure'), running('b')]).state).toBe('pending');
  });
});

describe('failed check names in the result line', () => {
  it('flattens control characters and caps a very long name, so the line stays one line', async () => {
    const long = 'x'.repeat(500);
    const { run } = fakeGh([{ sha: 'abc123', runs: [done('evil\nchecks: pass deadbeef\r\u001b[31m', 'failure'), done(long, 'failure')] }]);
    const line = render(await waitChecks(7, { gh: run, sleep: sleeper().sleep }));
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('evil checks: pass deadbeef');
    expect(line).toContain('x'.repeat(MAX_NAME_LENGTH - 1) + '…');
    expect(line).not.toContain('x'.repeat(MAX_NAME_LENGTH + 1));
  });
});

describe('waitChecks', () => {
  it('prints pass and exits 0 when every check completes green', async () => {
    const { run } = fakeGh([{ sha: 'abc123', runs: [done('verify', 'success'), done('pr checks', 'skipped')] }]);
    const result = await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('checks: pass abc123');
    expect(exitCode(result)).toBe(0);
  });

  it('prints fail with the failed check names and exits 1', async () => {
    const { run } = fakeGh([{ sha: 'abc123', runs: [done('verify', 'failure'), done('lint', 'success'), done('e2e', 'cancelled')] }]);
    const result = await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('checks: fail abc123 verify, e2e');
    expect(exitCode(result)).toBe(1);
  });

  it('prints pending after 40 attempts and exits 2, sleeping 30s between them', async () => {
    const { run, calls } = fakeGh([{ sha: 'abc123', runs: [running('verify')] }]);
    const { sleep, slept } = sleeper();
    const result = await waitChecks(7, { gh: run, sleep });
    expect(render(result)).toBe('checks: pending after 40 attempts abc123');
    expect(exitCode(result)).toBe(2);
    expect(calls.filter((c) => c[1]!.includes('check-runs'))).toHaveLength(CHECK_ATTEMPTS);
    expect(slept).toHaveLength(CHECK_ATTEMPTS - 1);
    expect(new Set(slept)).toEqual(new Set([INTERVAL_MS]));
  });

  it('keeps waiting through an empty list, then passes', async () => {
    const { run } = fakeGh([{ sha: 'abc123', runs: [] }, { sha: 'abc123', runs: [] }, { sha: 'abc123', runs: [done('verify', 'success')] }]);
    const result = await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    expect(result).toMatchObject({ state: 'pass', attempts: 3 });
  });

  it('counts a failed gh call as an attempt, then succeeds', async () => {
    const { run } = fakeGh([{ sha: 'abc123', fail: 'runs' }, { sha: 'abc123', runs: [done('verify', 'success')] }]);
    const result = await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    expect(result).toMatchObject({ state: 'pass', attempts: 2 });
  });

  it('counts a failed head read as an attempt too, and ends at the ceiling when gh never works', async () => {
    const { run } = fakeGh([{ sha: 'x', fail: 'head' }]);
    const result = await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('checks: pending after 40 attempts unknown');
    expect(exitCode(result)).toBe(2);
  });

  it('re-reads the head every attempt and judges the new commit after a push', async () => {
    const { run, calls } = fakeGh([
      { sha: 'old111', runs: [running('verify')] },
      { sha: 'new222', runs: [done('verify', 'failure')] },
    ]);
    const result = await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    expect(render(result)).toBe('checks: fail new222 verify');
    const asked = calls.filter((c) => c[1]!.includes('check-runs')).map((c) => c[1]);
    expect(asked[0]!).toContain('commits/old111/');
    expect(asked[1]!).toContain('commits/new222/');
  });

  it('reads GitHub through REST only', async () => {
    const { run, calls } = fakeGh([{ sha: 'abc123', runs: [done('verify', 'success')] }]);
    await waitChecks(7, { gh: run, sleep: sleeper().sleep });
    for (const call of calls) expect(call[0]).toBe('api');
    expect(calls[1]![1]).toBe('repos/{owner}/{repo}/commits/abc123/check-runs?per_page=100');
  });
});
