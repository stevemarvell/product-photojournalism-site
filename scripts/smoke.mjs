// Post-deploy smoke, for whatever project.json says is deployed.
//
// smoke.yml stays generic: the AI layer owns only the part that is the same
// for every app and every provider, and each app and its provider own the
// rest:
//
// 1. The freshness gate — the one check that tells a *current* deployment
//    from a stale one. A commit touching only a path outside a watch list
//    can fall through and silently deploy nothing, while every other check
//    passes, because each asks whether the deployed API is correct and none
//    asks whether it is *this* one. Each deployed app reports the commit it
//    was built from at its `deploy.commitEndpoint`. The gate accepts this
//    commit, or an older one whose build inputs are identical according to
//    its provider — which is what a build its provider's ignore step skipped
//    leaves behind (scripts/deploy/index.mjs's registry; "vercel"'s is
//    scripts/deploy/vercel/smoke.mjs) — asked through the same function
//    the ignore step uses (project.mjs's buildInputsChanged), so the two
//    cannot disagree. A skipped build passes at
//    once; a build that should have happened still has to show up.
// 2. The app's own checks, in the script its `smoke` field names, with every
//    deployed app's URL in the environment under its name upper-cased
//    ($API, $WEB), since one app's checks can need another's origin (CORS).
//
// Apps run in project.json order, each gate before its checks, and the first
// failure stops the run. Ceiling: GATE_ATTEMPTS × GATE_INTERVAL_MS per app,
// declared in docs/sops.md.
//
// A scheduled run (uptime monitoring) and a manual workflow_dispatch have no
// new commit to wait for, so gateForEvent turns the freshness gate off for
// exactly those two triggers: smoke() then accepts whatever each app
// currently reports — still logging what that is, and still failing the app
// if its commit endpoint reports nothing at all — and goes straight to that
// app's own checks. Every other trigger, including one this doesn't
// recognise, gates: fail closed, not open, on the unexpected case.
//
// When nothing in project.json is deployed, smoke.yml checks
// `node scripts/project.mjs --has-deploy` before this ever runs; this module
// does not have to know that, since `deployed(project)` is then empty and
// the loop below simply does nothing.
//
// Usage (smoke.yml runs it with a full-history checkout, fetch-depth: 0):
//     node scripts/smoke.mjs            # the commit is $GITHUB_SHA, the
//                                        # gate follows $GITHUB_EVENT_NAME
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provider } from './deploy/index.mjs';
import { ROOT, deployed, loadProject } from './project.mjs';

export const GATE_ATTEMPTS = 40;
export const GATE_INTERVAL_MS = 15_000;

/** Every deployed app's URL, keyed by its name upper-cased: { API: ..., WEB: ... }. */
export function appUrls(project) {
  return Object.fromEntries(deployed(project).map(([name, app]) => [name.toUpperCase().replace(/[^A-Z0-9]/g, '_'), app.deploy.url]));
}

export function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The production git runner: stdout matters, buildInputsChanged reads `git show`. */
export function runGit(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

async function reportedCommit(fetchJson, url) {
  try {
    const body = await fetchJson(url);
    // Reaches `git diff` and `git show` as a revision: anything but a full
    // lowercase SHA is an unknown deployment, which keeps polling and fails safe.
    return isCommitSha(body?.commit) ? body.commit : '';
  } catch {
    return ''; // A cold start or a stale route: not an answer yet, go round again.
  }
}

/** Wait until the app reports `sha`, or a commit with identical build inputs. */
export async function waitForCommit({ project, name, sha, fetchJson, git, sleep, log, attempts = GATE_ATTEMPTS }) {
  const app = project.apps[name];
  const endpoint = `${app.deploy.url}${app.deploy.commitEndpoint}`;
  const { buildIsEquivalent } = provider(app.deploy.provider);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const deployedSha = await reportedCommit(fetchJson, endpoint);
    log(`${name} attempt ${attempt}: deployed=${deployedSha || '<none>'}`);
    if (deployedSha === sha) return { ok: true, reason: `${name} is serving this commit` };
    if (deployedSha && buildIsEquivalent({ git, project, name, deployedSha, sha })) {
      return { ok: true, reason: `${name} is serving ${deployedSha}, whose inputs match this commit; its build was skipped` };
    }
    if (attempt < attempts) await sleep(GATE_INTERVAL_MS);
  }
  return { ok: false, reason: `${name} never reported ${sha} after ${attempts} attempts; it is serving an older build` };
}

/** Whether this trigger names a commit the deployment must match. Only an
 * explicit `schedule` or manual `workflow_dispatch` has nothing new to wait
 * for (see smoke()); every other trigger, including one this doesn't
 * recognise or that isn't set at all, gates — failing open here would mean
 * an unexpected event (a push under a name this hasn't been taught) quietly
 * skips the one check that catches a stale deploy. */
export function gateForEvent(eventName) {
  return eventName !== 'schedule' && eventName !== 'workflow_dispatch';
}

/** Gate and check every deployed app. Stops at the first failure.
 * `gate: false` (a scheduled or manually dispatched run) skips the
 * freshness wait entirely: each app is checked once, its reported commit is
 * logged for the record, and its own checks run regardless of whether that
 * commit matches `sha`. */
export async function smoke({ project, sha, fetchJson, git, sleep, run, log, gate = true }) {
  // Nothing deployed (an engine-only product, or an app not yet through
  // `deploy:add`) leaves nothing to wait for or check, so no commit is needed
  // either: the answer does not depend on $GITHUB_SHA. Anything deployed still
  // fails closed without one, just below.
  if (deployed(project).length === 0) return { ok: true, reason: 'nothing is deployed (no app has a deploy block): nothing to check' };
  if (gate && !sha) return { ok: false, reason: 'no commit to check: GITHUB_SHA is not set' };
  const urls = appUrls(project);
  for (const [name, app] of deployed(project)) {
    if (gate) {
      log(`::group::${name}: freshness gate`);
      const result = await waitForCommit({ project, name, sha, fetchJson, git, sleep, log });
      log(result.reason);
      log('::endgroup::');
      if (!result.ok) return result;
    } else {
      const endpoint = `${app.deploy.url}${app.deploy.commitEndpoint}`;
      const deployedSha = await reportedCommit(fetchJson, endpoint);
      if (!deployedSha) {
        return { ok: false, reason: `${name} is unreachable: its commit endpoint (${endpoint}) reported nothing` };
      }
      log(`${name}: freshness gate skipped (no new commit to wait for); accepting whatever is deployed, serving ${deployedSha}`);
    }
    if (app.smoke) {
      const status = run(app.smoke, urls);
      if (status !== 0) return { ok: false, reason: `${name}: ${app.smoke} failed (exit ${status})` };
    }
  }
  return {
    ok: true,
    reason: gate
      ? 'every deployed app is current and passed its checks'
      : 'every deployed app answered and passed its checks (freshness gate skipped: no new commit to wait for)',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await smoke({
    project: loadProject(),
    sha: process.env.GITHUB_SHA,
    gate: gateForEvent(process.env.GITHUB_EVENT_NAME),
    fetchJson: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json();
    },
    git: runGit,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: (script, urls) =>
      spawnSync('bash', [script], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...urls } }).status ?? -1,
    log: (line) => console.log(line),
  });
  console.log(result.reason);
  process.exit(result.ok ? 0 : 1);
}
