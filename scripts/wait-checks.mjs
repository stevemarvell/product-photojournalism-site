// Wait for a pull request's check runs to settle, and say how they settled.
//
// This replaces the inline `for attempt in $(seq 1 40)` loop that
// `.claude/skills/drive-pr/SKILL.md` step 1 used to carry: waiting costs no
// model turns, and one command is one allow-list entry. The semantics are
// the loop's, unchanged:
//
//   - a check run that has not completed is pending;
//   - a completed one passes on success, skipped or neutral, and fails on
//     any other conclusion (a cancelled or timed-out run is a failure);
//   - an empty list is pending (right after a push GitHub has registered
//     nothing yet), and so is any pending run, even beside a failed one;
//   - a failed `gh` call counts as an attempt, like any other;
//   - the head sha is re-read on every attempt, because a fix pushed during
//     the wait changes it.
//
// One line on stdout, and the exit code says the rest: 0 pass, 1 fail,
// 2 still pending when the ceiling was reached (docs/sops.md SOP 1).
//
// GitHub is read through `gh api` REST only: cloud sessions refuse GraphQL
// (#225). `gh` and `sleep` are injectable, as in scripts/stuck.mjs, so the
// tests make no network calls and wait no time.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './project.mjs';

/** Attempts before giving up; the ceiling SOP 1 declares for this poll. */
export const CHECK_ATTEMPTS = 40;

/** Wait between attempts. */
export const INTERVAL_MS = 30000;

const PASSING = new Set(['success', 'skipped', 'neutral']);

/** Runs `gh` with `args`, resolving to its exit status, stdout and stderr. Never rejects. */
export function gh(args) {
  return new Promise((resolvePromise) => {
    execFile('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ status: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const realSleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Longest check name printed; names are data from the pull request, and the result stays one line. */
export const MAX_NAME_LENGTH = 100;

/** A check name made safe for one line of output: control characters (newlines included) become spaces, capped at MAX_NAME_LENGTH. */
export function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const flat = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return flat.length > MAX_NAME_LENGTH ? `${flat.slice(0, MAX_NAME_LENGTH - 1)}…` : flat;
}

/**
 * Judge a list of check runs: `{ state, failed }`. `state` is `pending`
 * when the list is empty or any run has not completed, else `fail` when any
 * completed run did not succeed, skip or come out neutral, else `pass`.
 * `failed` names the failing runs.
 */
export function judge(checkRuns) {
  const runs = checkRuns ?? [];
  if (runs.length === 0 || runs.some((run) => run.status !== 'completed')) return { state: 'pending', failed: [] };
  const failed = runs.filter((run) => !PASSING.has(run.conclusion)).map((run) => cleanName(run.name));
  return failed.length > 0 ? { state: 'fail', failed } : { state: 'pass', failed: [] };
}

/**
 * Read the head sha and judge its check runs, once. Throws, with gh's own
 * message, when a call fails or answers something unreadable; the caller
 * counts that as an attempt.
 */
export async function readChecks(run, pull) {
  const head = await run(['api', `repos/{owner}/{repo}/pulls/${pull}`, '--jq', '.head.sha']);
  if (head.status !== 0) throw new Error(`could not read the head: ${(head.stderr || head.stdout).trim()}`);
  const sha = head.stdout.trim();
  const runs = await run(['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`]);
  if (runs.status !== 0) throw new Error(`gh failed: ${(runs.stderr || runs.stdout).trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(runs.stdout);
  } catch {
    throw new Error(`gh answered something that is not JSON for ${sha}`);
  }
  return { sha, ...judge(parsed.check_runs) };
}

/**
 * Wait for pull request `pull`'s checks. Resolves to `{ state, sha, failed,
 * attempts }` with `state` of `pass`, `fail` or `pending` (the ceiling was
 * reached). `sha` is the last head read, `unknown` if none ever was.
 */
export async function waitChecks(
  pull,
  { gh: run = gh, sleep = realSleep, attempts = CHECK_ATTEMPTS, intervalMs = INTERVAL_MS, log = () => {} } = {},
) {
  let sha = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await readChecks(run, pull);
      sha = result.sha;
      log(`attempt ${attempt}: ${result.state}`);
      if (result.state !== 'pending') return { ...result, attempts: attempt };
    } catch (error) {
      log(`attempt ${attempt}: ${error.message}`);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return { state: 'pending', sha, failed: [], attempts };
}

/** The single result line. */
export function render(result) {
  if (result.state === 'pass') return `checks: pass ${result.sha}`;
  if (result.state === 'fail') return `checks: fail ${result.sha} ${result.failed.join(', ')}`;
  return `checks: pending after ${result.attempts} attempts ${result.sha}`;
}

/** The exit code for a result: 0 pass, 1 fail, 2 pending at the ceiling. */
export function exitCode(result) {
  return result.state === 'pass' ? 0 : result.state === 'fail' ? 1 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pull = process.argv[2];
  if (!/^\d+$/.test(pull ?? '')) {
    process.stderr.write('usage: node scripts/wait-checks.mjs <pull request number>\n');
    process.exitCode = 64;
  } else {
    // exitCode, not exit(): exit() right after a write can drop output on a pipe.
    const result = await waitChecks(pull, { log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${render(result)}\n`);
    process.exitCode = exitCode(result);
  }
}
