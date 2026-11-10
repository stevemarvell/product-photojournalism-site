// Which commit did the automated reviews last actually review?
//
// drive-pr step 4 needs it to ask "what changed since a review looked?". The
// obvious answer, the head of the newest `claude-code-review.yml` run, is wrong
// in three ways that each read as "reviewed" when nothing was:
//
//   - a run that failed without producing a review (`claude-code-action`
//     refuses a pull request that edits workflows; `assert-review-ran` fails;
//     a Dependabot pull request has no credential);
//   - a label-only run whose jobs were all skipped (any label other than
//     `re-review` starts this workflow and skips everything);
//   - a cancelled run.
//
// So a run counts only when every review job that ran was a review:
//
//   - at least one of `code review` / `security review` is not `skipped` (a
//     review skipped by scope is simply not wanted, and does not spoil a run
//     whose other review succeeded);
//   - every such job has `conclusion == "success"`, so a run in which one review
//     succeeded and the other failed or was cancelled is not "reviewed";
//   - in each, the step `Check a review was actually produced` (the
//     assert-review-ran step) has `conclusion == "success"`. A Dependabot run
//     with no credential skips every step and ENDS GREEN, and its job
//     conclusion alone would read as a review; the step is the evidence.
//
// The newest run that meets that is what is wanted.
//
// CLI:  node scripts/last-reviewed.mjs <branch>
//   exit 0  prints the head sha last reviewed
//   exit 3  prints `none`: no run has reviewed this branch and none is
//           running (the initial review never ran or failed)
//   exit 4  prints `pending`: a run has not finished (the initial review is
//           queued or running, or a newer one is); wait, and do not add
//           `re-review`
//   exit 2  `gh` failed (an API error is not "no runs"); says why on stderr
//
// The branch reaches `gh` as an argument, never through a shell, so a branch
// name cannot inject anything.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The review jobs. */
export const REVIEW_JOBS = ['code review', 'security review'];

/** The step in each review job that fails unless a review was actually produced. */
export const ASSERT_STEP = 'Check a review was actually produced';

/** Whether a run's jobs amount to a review, by the rule in this file's header. */
export function isReview(jobs) {
  const ran = (jobs ?? []).filter((job) => REVIEW_JOBS.includes(job.name) && job.conclusion !== 'skipped');
  if (ran.length === 0) return false;
  return ran.every((job) => job.conclusion === 'success' && (job.steps ?? []).some((step) => step.name === ASSERT_STEP && step.conclusion === 'success'));
}

/** How many of the newest runs are examined: the loop is bounded (SOP 1). */
export const MAX_RUNS = 20;

/**
 * `runs`: the `workflow_runs` array, newest first, as the REST API returns it.
 * `jobsFor(run)`: that run's `jobs` array.
 * Returns `{ state: 'reviewed', sha }`, `{ state: 'pending' }` when a run newer
 * than the last review has not completed, or `{ state: 'none' }`.
 */
export function lastReviewed(runs, jobsFor) {
  let pending = false;
  for (const run of (runs ?? []).slice(0, MAX_RUNS)) {
    if (run.status !== 'completed') {
      pending = true;
      continue;
    }
    if (isReview(jobsFor(run))) return pending ? { state: 'pending', sha: run.head_sha } : { state: 'reviewed', sha: run.head_sha };
  }
  return pending ? { state: 'pending' } : { state: 'none' };
}

function gh(args) {
  return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', ...args], { encoding: 'utf8' }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const branch = process.argv[2];
  if (!branch) {
    console.error('usage: node scripts/last-reviewed.mjs <branch>');
    process.exit(2);
  }
  let result;
  try {
    const { workflow_runs: runs } = gh([
      'repos/{owner}/{repo}/actions/workflows/claude-code-review.yml/runs',
      '-f', 'event=pull_request',
      '-f', `branch=${branch}`,
      '-f', `per_page=${MAX_RUNS}`,
    ]);
    result = lastReviewed(runs, (run) => gh([`repos/{owner}/{repo}/actions/runs/${run.id}/jobs`, '-f', 'per_page=100']).jobs);
  } catch (error) {
    console.error(`last-reviewed: gh failed: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  if (result.state === 'reviewed') {
    console.log(result.sha);
  } else if (result.state === 'pending') {
    console.log('pending');
    process.exit(4);
  } else {
    console.log('none');
    process.exit(3);
  }
}
