// Vercel's Ignored Build Step: skip a build when nothing it reads has changed.
//
// Every Vercel project that deploys an app from this repository rebuilds on
// every push to every branch, whatever the push touched, unless its own
// vercel.json's `ignoreCommand` runs this:
//
//     node ../../scripts/deploy/vercel/vercel-ignore.mjs <app>
//
// (`npm run deploy:add -- vercel --app <app>` writes that vercel.json from
// scripts/deploy/vercel/template/.)
//
// Vercel reads the exit code backwards from what you would guess: 0 means
// *skip* the build, anything else means build. Every path through here that
// cannot prove "nothing changed" builds — a missing base commit, a failed
// fetch, a git error, even node itself failing to start. The cost of being
// wrong that way is one redundant build; the cost of being wrong the other
// way is a deployment that silently never happens.
//
// The base is VERCEL_GIT_PREVIOUS_SHA — the last *successful* deployment of
// this project on this branch — so a skipped build never becomes a base, and
// the next build diffs against the last one that actually shipped. A branch's
// first push has none; that compares against where it left develop instead
// (`forkPoint`).
//
// scripts/smoke.mjs asks the same question after a merge, through the same
// function (project.mjs's buildInputsChanged), so a skipped build is not
// mistaken for a stale one.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCommitSha } from '../../smoke.mjs';
import { buildInputsChanged, buildPathspecs, loadProject } from '../../project.mjs';

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// What each build reads comes from project.json: an app's `reads`
// and `ignores`, plus scripts/project.mjs and this script, which can change any
// decision. See scripts/project.mjs's buildPathspecs. project.json itself is
// NOT watched as a file: every engine sync bumps `engine.commit` in it, which
// would rebuild every app for a commit that changed nothing it ships. When it
// differs, base and HEAD are compared with exactly the `engine` block and the
// OTHER apps' entries removed; anything else that differs (this app's entry,
// the top-level `name`, an unknown key) builds, and so does anything
// unreadable or unparseable. See
// buildInputsChanged. The list is what a build
// reads, not what it does not, so a path no app declares rebuilds nothing;
// smoke.yml's two freshness gates are what catch a read left undeclared.

// Decide whether to build. `git` runs a git command in the repository root and
// returns { status, stdout }. Returns { build, reason }.
export function decide(project, env, git, manifest = loadProject()) {
  const pathspecs = buildPathspecs(manifest, project);
  if (!pathspecs) return { build: true, reason: `unknown project "${project}"` };

  let base = env.VERCEL_GIT_PREVIOUS_SHA;
  if (base) {
    // Untrusted input: only a full lowercase sha is ever handed to git.
    if (!isCommitSha(base)) return { build: true, reason: 'previous deployment sha is not a commit id' };
    // Vercel's clone is shallow; the last deployed commit may be outside it.
    if (!hasCommit(git, base) && git(['fetch', '--no-tags', '--depth=1', '--end-of-options', 'origin', base]).status !== 0) {
      return { build: true, reason: `cannot fetch the previous deployment's commit ${base}` };
    }
  } else if (env.VERCEL_ENV === 'production') {
    // No successful production deployment has ever happened, so there is
    // nothing to be unchanged *from*: a fork point here would only say whether
    // the last merge touched this app, and every earlier merge that did would
    // stay undeployed. A fresh project hits this on its first merge.
    return { build: true, reason: 'no previous production deployment' };
  } else {
    base = forkPoint(git);
    if (!base) return { build: true, reason: 'no previous deployment, and no merged pull request in the clone' };
  }

  const answer = buildInputsChanged({ git, project: manifest, name: project, base, head: 'HEAD' });
  if (answer === 'unchanged') return { build: false, reason: `nothing ${project} reads changed since ${base}` };
  if (answer === 'changed') return { build: true, reason: `${project} changed since ${base}` };
  return { build: true, reason: `git diff failed against ${base}` };
}

// Where a branch left develop, found without develop. Vercel's clone has no
// credentials to fetch it, but it does
// hold the branch's last few ancestors, and develop's commits are recognisable:
// squash merges, committed by GitHub, with one parent and a "(#123)" subject.
// A branch's own commits are committed locally, and GitHub's "update branch"
// merges have two parents, so neither is mistaken for one. The nearest such
// ancestor is the fork point, or near enough that the diff only over-counts.
// HEAD itself never is: the log's first line is HEAD, and on develop that is a
// squash merge, which would compare HEAD with HEAD and skip every build.
export function forkPoint(git) {
  const log = git(['log', '-n', '50', '--format=%H%x09%P%x09%ce%x09%s', 'HEAD']);
  if (log.status !== 0) return null;
  for (const line of log.stdout.split('\n').slice(1)) {
    const [sha, parents, committer, subject] = line.split('\t');
    if (!sha || parents === undefined || subject === undefined) continue;
    if (committer === 'noreply@github.com' && parents.split(' ').length === 1 && /\(#\d+\)$/.test(subject)) {
      return sha;
    }
  }
  return null;
}

function hasCommit(git, sha) {
  return git(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`]).status === 0;
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { build, reason } = decide(process.argv[2], process.env, runGit);
  console.log(`vercel-ignore: ${build ? 'building' : 'skipping'} — ${reason}`);
  process.exit(build ? 1 : 0);
}
