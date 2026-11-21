// Tell "CI did not run" from "CI ran and failed", from the jobs alone.
//
// When a repository's Actions allowance is spent, GitHub refuses every job
// before a runner starts. The job completes `failure` with no steps and no
// runner ever assigned: `runner_id: 0`, `runner_name: ""`. A job that ran had
// a runner, however fast it failed, so duration is not used: a real failure
// can be quick too, and a pull request cannot fake a missing runner by failing
// its own verify early. Observed: the 2026-11-14 refused job had
// `runner_id: 0`, `runner_name: ""` (scripts/test/fixtures/refused-job-2026-11-14.json).
// Only `runner_id: 0` counts. A never-assigned job reporting `null` or no
// `runner_id` has not been observed; it is treated as an ordinary red check,
// which fails toward waiting for CI rather than toward the local path. Input is the job objects from
// `gh api repos/{owner}/{repo}/actions/jobs/<check_run_id>` (a check run's id
// is its job id), one per failed check run.
import { pathToFileURL } from 'node:url';

/** True when no runner was ever assigned to the job. */
const neverGotARunner = (job) => job?.runner_id === 0;

/**
 * True when there is at least one job and every one is `completed` with
 * conclusion `failure` and never got a runner. A success, a failure that had
 * a runner, or an unfinished job makes it false: an ordinary check result.
 * @param {Array<{status?: string, conclusion?: string | null, runner_id?: number | null, runner_name?: string | null}> | null | undefined} jobs
 */
export function ciDidNotRun(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  return jobs.every(
    (job) =>
      job?.status === 'completed' && job.conclusion === 'failure' && neverGotARunner(job),
  );
}

// CLI: a JSON array of jobs on stdin; prints `true` or `false`; exit 2 on
// unreadable input.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let jobs;
  try {
    jobs = JSON.parse(input);
  } catch (err) {
    console.error(`ci-health: stdin is not JSON: ${err.message}`);
    process.exit(2);
  }
  console.log(String(ciDidNotRun(jobs)));
}
