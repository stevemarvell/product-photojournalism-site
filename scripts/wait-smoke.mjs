// Wait for the post-merge `smoke` run of a merged pull request.
//
// This replaces the inline `for attempt in $(seq 1 30)` loop that
// `.claude/skills/drive-pr/SKILL.md` "After a merge" used to carry. The run
// is pinned to the merge commit (`head_sha`), so a poll that lands before
// GitHub registers the new run waits instead of reading the previous
// merge's result. A run that is not registered yet, or not completed, is
// pending; a completed one passes on `success` and fails on anything else.
// A failed `gh` call counts as an attempt.
//
// One line on stdout, and the exit code says the rest: 0 pass, 1 fail,
// 2 still pending when the ceiling was reached (docs/sops.md SOP 1). A pass
// or a fail also names the run id, which the skill reads the log tail from.
// A pull request that is not merged exits 64 (a precondition, not a smoke
// result) with a line saying so.
//
// GitHub is read through `gh api` REST only (#225); `gh` and `sleep` are
// injectable, as in scripts/stuck.mjs.
import { pathToFileURL } from 'node:url';
import { gh, INTERVAL_MS } from './wait-checks.mjs';

export { INTERVAL_MS };

/** Attempts before giving up; the ceiling SOP 1 declares for this poll. */
export const SMOKE_ATTEMPTS = 30;

const realSleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Thrown when the pull request has no merge commit to wait on. */
export class NotMergedError extends Error {}

/**
 * Judge the `smoke` runs GitHub lists for a commit: `{ state, run }`.
 * No run yet, or one not completed, is `pending`; `success` is `pass`;
 * any other conclusion is `fail`. `run` is the run's id, if there is one.
 */
export function judge(workflowRuns) {
  const latest = (workflowRuns ?? [])[0];
  if (!latest || latest.status !== 'completed') return { state: 'pending', run: latest?.id ?? null };
  return { state: latest.conclusion === 'success' ? 'pass' : 'fail', run: latest.id };
}

/** One read: the merge commit, then its `smoke` run. Throws with gh's own message on a failed call. */
export async function readSmoke(run, pull) {
  const merged = await run([
    'api',
    `repos/{owner}/{repo}/pulls/${pull}`,
    '--jq',
    'if .merged then .merge_commit_sha else "" end',
  ]);
  if (merged.status !== 0) throw new Error(`could not read the pull request: ${(merged.stderr || merged.stdout).trim()}`);
  const sha = merged.stdout.trim();
  if (!sha) throw new NotMergedError(`pull request #${pull} is not merged`);
  const runs = await run(['api', `repos/{owner}/{repo}/actions/workflows/smoke.yml/runs?head_sha=${sha}`]);
  if (runs.status !== 0) throw new Error(`gh failed: ${(runs.stderr || runs.stdout).trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(runs.stdout);
  } catch {
    throw new Error(`gh answered something that is not JSON for ${sha}`);
  }
  return { sha, ...judge(parsed.workflow_runs) };
}

/**
 * Wait for merged pull request `pull`'s smoke run. Resolves to `{ state,
 * sha, run, attempts }` with `state` of `pass`, `fail`, `pending` (the
 * ceiling was reached) or `not-merged`.
 */
export async function waitSmoke(
  pull,
  { gh: runGh = gh, sleep = realSleep, attempts = SMOKE_ATTEMPTS, intervalMs = INTERVAL_MS, log = () => {} } = {},
) {
  let sha = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await readSmoke(runGh, pull);
      sha = result.sha;
      log(`attempt ${attempt}: ${result.state}`);
      if (result.state !== 'pending') return { ...result, attempts: attempt };
    } catch (error) {
      if (error instanceof NotMergedError) {
        return { state: 'not-merged', sha, run: null, attempts: attempt, message: error.message };
      }
      log(`attempt ${attempt}: ${error.message}`);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return { state: 'pending', sha, run: null, attempts };
}

/** The single result line. */
export function render(result) {
  if (result.state === 'not-merged') return `smoke: ${result.message}`;
  if (result.state === 'pending') return `smoke: pending after ${result.attempts} attempts ${result.sha}`;
  return `smoke: ${result.state} ${result.sha} ${result.run}`;
}

/** The exit code for a result: 0 pass, 1 fail, 2 pending at the ceiling, 64 not merged. */
export function exitCode(result) {
  if (result.state === 'not-merged') return 64;
  return result.state === 'pass' ? 0 : result.state === 'pending' ? 2 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pull = process.argv[2];
  if (!/^\d+$/.test(pull ?? '')) {
    process.stderr.write('usage: node scripts/wait-smoke.mjs <pull request number>\n');
    process.exitCode = 64;
  } else {
    // exitCode, not exit(): exit() right after a write can drop output on a pipe.
    const result = await waitSmoke(pull, { log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${render(result)}\n`);
    process.exitCode = exitCode(result);
  }
}
