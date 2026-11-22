// Delete Vercel deployments nobody can need any more: previews of closed
// branches, and production history beyond the last few builds.
//
// Vercel never tears a preview down: the deployment and its
// `-git-<branch>-` alias outlive the merge and the branch (the `deployment`
// skill has the measurement), and Deployment Retention is not on this plan.
// .github/workflows/preview-prune.yml runs this with VERCEL_TOKEN, a token
// scoped to the one team the deployed apps name:
//
//     node scripts/deploy/vercel/vercel-prune.mjs branch <name>      # a pull request closed
//     node scripts/deploy/vercel/vercel-prune.mjs stale <live-branches-file> [--dry-run]
//     node scripts/deploy/vercel/vercel-prune.mjs history [--dry-run] # old production builds
//
// `branch` deletes that branch's previews. `stale` deletes every preview whose
// branch is not in the file — the branches that still exist on origin — which
// is how the backlog from before this existed gets cleared.
//
// `branch` and `stale` never delete a production deployment or anything built
// from `develop`. Those are checked per deployment, not trusted to the query,
// so a filter Vercel ignores cannot widen the delete.
//
// `history` is the one mode that deletes production deployments, because
// Vercel keeps one per merge forever on this plan. It keeps the deployment
// serving each app's URL (looked up by its alias, never inferred), the newest
// KEEP_PRODUCTION built ones for instant rollback (the live one normally among
// them), anything not finished (a build in flight), and any built deployment
// newer than the live one (history ahead of a rollback). Cancelled and failed
// records go whatever their age: they never built anything to roll back to.
// If the live deployment cannot be found, it deletes nothing. Every production
// deployment is a build of a commit on `develop`, which is never rewritten, so
// what it removes can be rebuilt; that is what lets it run unattended.
//
// A closed pull request's preview is rebuildable from its commit — GitHub
// keeps every pull request's head at refs/pull/<n>/head — so `branch` loses
// nothing that cannot be had back, which is what makes it safe to run
// unattended (`docs/sops.md` SOP 6: recoverability, not scope). `stale` has no
// such guarantee: a branch pushed and deleted without a pull request leaves a
// commit nothing keeps. So `stale` is only ever started by hand, and the
// workflow defaults it to --dry-run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRODUCTION_BRANCH, deployed, loadProject, productionBranch } from '../../project.mjs';

// Every app deployed to Vercel, from project.json: an app whose `deploy`
// block names this provider.
const PROJECT = loadProject();
const VERCEL_APPS = deployed(PROJECT).filter(([, app]) => app.deploy.provider === 'vercel');

// All of them have to share one team: a Vercel token is scoped to a team,
// not a project, so there is exactly one TEAM to ask the API as.
const TEAMS = new Set(VERCEL_APPS.map(([, app]) => app.deploy.team));
if (TEAMS.size > 1) {
  throw new Error(`vercel-prune.mjs: apps declare different Vercel teams (${[...TEAMS].join(', ')}); only one is supported`);
}
export const TEAM = [...TEAMS][0];
export const PROJECTS = VERCEL_APPS.map(([, app]) => app.deploy.project);
/** Each deployed app's Vercel project and the host its production alias answers on. */
export const TARGETS = VERCEL_APPS.map(([, app]) => ({ project: app.deploy.project, host: new URL(app.deploy.url).host }));
/** Built production deployments kept, newest first, for instant rollback; the live one is always kept too. */
export const KEEP_PRODUCTION = 3;
/** States a deployment is finished in; anything else is still in flight. */
const FINISHED = new Set(['READY', 'CANCELED', 'ERROR']);
/** project.json's production branch. `develop` is protected as well (below): it is staging when this is `main`. */
export const PRODUCTION_BRANCH = productionBranch(PROJECT);
const protectedBranches = (production) => new Set([production, DEFAULT_PRODUCTION_BRANCH]);
// 100 deployments a page; 20 pages is 2,000 per project, twenty times the
// whole backlog this was written to clear. Hitting it is reported, not retried.
export const MAX_PAGES = 20;

const API = 'https://api.vercel.com';

/** Whether a deployment may be deleted at all, before any branch rule. */
export function isPreview(deployment, production = PRODUCTION_BRANCH) {
  const ref = deployment.meta?.githubCommitRef;
  return deployment.target !== 'production' && Boolean(ref) && !protectedBranches(production).has(ref);
}

/** The deployments to delete, given what should be kept. */
export function select(deployments, rule, production = PRODUCTION_BRANCH) {
  return deployments.filter((d) => {
    if (!isPreview(d, production)) return false;
    const ref = d.meta.githubCommitRef;
    return rule.branch !== undefined ? ref === rule.branch : !rule.live.has(ref);
  });
}

const idOf = (d) => d.uid ?? d.id;
const stateOf = (d) => d.state ?? d.readyState;
const createdOf = (d) => d.created ?? d.createdAt ?? 0;

/**
 * The production deployments `history` may delete: finished, not among the
 * newest `keep` built ones, and — if built — older than the live one. Throws — deleting
 * nothing — when it cannot see the live deployment in the list.
 */
export function selectHistory(deployments, { liveId, keep = KEEP_PRODUCTION }) {
  if (!liveId) throw new Error('no live deployment id; refusing to prune production history');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be at least 1');
  const production = deployments.filter((d) => d.target === 'production');
  const live = production.find((d) => idOf(d) === liveId);
  if (!live) throw new Error(`live deployment ${liveId} is not among the production deployments; refusing`);
  // The newest `keep` built deployments, then the live one whether or not it
  // is among them (after a rollback it may not be).
  const kept = new Set();
  for (const d of [...production].sort((a, b) => createdOf(b) - createdOf(a))) {
    if (kept.size === keep) break;
    if (stateOf(d) === 'READY') kept.add(idOf(d));
  }
  kept.add(liveId);
  return production.filter(
    // Only a built deployment newer than the live one is protected — it is
    // history ahead of a rollback, and could be rolled forward to. A cancelled
    // or failed one never built anything to roll to, whatever its age; the
    // ignore step leaves one of those per merge that skips an app.
    (d) =>
      !kept.has(idOf(d)) &&
      FINISHED.has(stateOf(d)) &&
      (stateOf(d) !== 'READY' || createdOf(d) < createdOf(live)),
  );
}

/** Every deployment of `project`, optionally for one branch or target. Throws on ceiling. */
export async function listDeployments(fetchJson, project, branch, target) {
  const all = [];
  let until;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ projectId: project, slug: TEAM, limit: '100' });
    if (branch) query.set('branch', branch);
    if (target) query.set('target', target);
    if (until) query.set('until', String(until));
    const body = await fetchJson(`${API}/v6/deployments?${query}`);
    all.push(...body.deployments);
    until = body.pagination?.next;
    if (!until) return all;
  }
  throw new Error(`${project}: more than ${MAX_PAGES} pages of deployments; stopped rather than guess`);
}

/** Delete what `rule` selects across both projects. Returns what it did. */
/** `projects` defaults to project.json's deployed apps; tests pass their own. */
export async function prune({ fetchJson, remove, rule, dryRun = false, log = console.log, projects = PROJECTS }) {
  const deleted = [];
  for (const project of projects) {
    const deployments = await listDeployments(fetchJson, project, rule.branch);
    for (const d of select(deployments, rule)) {
      const id = d.uid ?? d.id;
      log(`${dryRun ? 'would delete' : 'deleting'} ${project} ${id} (${d.meta.githubCommitRef})`);
      if (!dryRun) await remove(id);
      deleted.push({ project, id, branch: d.meta.githubCommitRef });
    }
  }
  return deleted;
}

/**
 * Delete production history across every deployed app. Returns what it did.
 *
 * Two phases: every app's live deployment and deletion list are worked out
 * first, and nothing is deleted unless all of them were. One app's failed
 * alias lookup therefore stops the whole run before any app loses anything —
 * the "deletes nothing" guarantee holds for the run, not only per app. A
 * version that deletes as it goes, one app's loop at a time, can delete the
 * first app's history and then fail on the second.
 */
export async function pruneHistory({ fetchJson, remove, dryRun = false, log = console.log, targets = TARGETS, keep = KEEP_PRODUCTION }) {
  const plans = [];
  for (const { project, host } of targets) {
    const alias = await fetchJson(`${API}/v4/aliases/${encodeURIComponent(host)}?slug=${TEAM}`);
    const liveId = alias?.deploymentId;
    const production = await listDeployments(fetchJson, project, undefined, 'production');
    const doomed = selectHistory(production, { liveId, keep });
    log(`${project}: live ${liveId} on ${host}; ${production.length} production, ${doomed.length} to remove`);
    plans.push({ project, doomed });
  }
  const deleted = [];
  for (const { project, doomed } of plans) {
    for (const d of doomed) {
      log(`${dryRun ? 'would delete' : 'deleting'} ${project} ${idOf(d)} (${stateOf(d)}, ${d.meta?.githubCommitSha?.slice(0, 7) ?? '?'})`);
      if (!dryRun) await remove(idOf(d));
      deleted.push({ project, id: idOf(d), state: stateOf(d) });
    }
  }
  return deleted;
}

function vercel(token) {
  const call = async (method, url) => {
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${method} ${url.split('?')[0]}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  return {
    fetchJson: (url) => call('GET', url),
    remove: (id) => call('DELETE', `${API}/v13/deployments/${encodeURIComponent(id)}?slug=${TEAM}`),
  };
}

export async function main(argv, env) {
  const token = env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN is not set');
  const [mode, arg, flag] = argv;
  if (mode === 'history') {
    const dryRun = arg === '--dry-run';
    const deleted = await pruneHistory({ ...vercel(token), dryRun });
    console.log(`${dryRun ? 'would delete' : 'deleted'} ${deleted.length} old production deployment(s)`);
    return;
  }
  let rule;
  if (mode === 'branch' && arg) {
    rule = { branch: arg };
  } else if (mode === 'stale' && arg) {
    const live = new Set(readFileSync(arg, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
    // An empty list would mean "every branch is gone" and delete every preview.
    if (live.size === 0) throw new Error(`${arg} lists no live branches; refusing to treat every preview as stale`);
    rule = { live };
  } else {
    throw new Error('usage: vercel-prune.mjs branch <name> | stale <live-branches-file> [--dry-run] | history [--dry-run]');
  }
  const deleted = await prune({ ...vercel(token), rule, dryRun: flag === '--dry-run' });
  console.log(`${flag === '--dry-run' ? 'would delete' : 'deleted'} ${deleted.length} preview deployment(s)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
