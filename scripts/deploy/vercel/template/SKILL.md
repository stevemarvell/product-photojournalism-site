---
name: deployment
description: The non-obvious settings behind this app's Vercel deployment — Root Directory, build-time environment variables, and how preview environments live and die. Read before changing anything that deploys, or any build-time environment variable.
---

# Deploying <app>

`npm run deploy:add -- vercel --app <app> ...` wrote this file (to
`apps/<app>/.claude/skills/deployment/`, from
`scripts/deploy/vercel/template/SKILL.md`) and the `deploy` block in
`project.json` it describes. Replace every `<placeholder>` below with the
real value once you know it, the same way the owner steps that command
printed said to.

Every item here should be measured against a live deployment rather than
assumed. None of it is guessable from the code.

Load-bearing and non-obvious settings:

- The Vercel project (`<project>`, team `<team>`) has its **Root Directory**
  set to `apps/<app>` in the dashboard. Vercel clones the whole repository
  but then reads this app's own lockfiles and build config relative to that
  root, not the repository root.
- Left alone, Vercel builds on **every** push to every branch — production on
  `develop`, a preview everywhere else — whatever the push touched.
  `apps/<app>/vercel.json` sets an `ignoreCommand` running
  `scripts/deploy/vercel/vercel-ignore.mjs`, which diffs
  `VERCEL_GIT_PREVIOUS_SHA` (the last *successful* deployment, so never a
  skipped one) against `HEAD` over the paths this app reads (`project.json`'s
  `reads`/`ignores` for `<app>`), and skips when nothing changed. A branch's
  first push has no previous SHA, and Vercel's clone cannot fetch `develop`
  (no credentials), so it compares with the nearest squash-merge ancestor
  instead (`forkPoint`). Exit 0 means *skip*; every failure path exits 1 and
  builds.
- Smoke's freshness gate (`scripts/smoke.mjs`) accepts a deployed app
  reporting the merged commit, or an older one whose build inputs are
  identical, asked of git with the ignore step's own pathspecs — so a skipped
  build is not a stale one and the two cannot disagree. `project.json`'s
  `deploy.commitEndpoint` for `<app>` must report `VERCEL_GIT_COMMIT_SHA` as
  `commit` in its JSON body.
- `deploy.url` in `project.json` has to be the **real** production URL,
  copied from the project's domain list on Vercel — never inferred. Vercel's
  short alias (`<project>.vercel.app`) is not guaranteed to be the one
  serving production.

## Preview environments

Every pull request that changes what this app reads gets a Vercel preview of
it (`scripts/deploy/vercel/vercel-ignore.mjs` skips it otherwise). Find a
specific pull request's own preview at its Vercel branch alias,
`<project>-git-<branch>-<team>.vercel.app` (slugified: lowercase,
non-alphanumeric runs collapsed to one hyphen) — **but only for a short
branch name**. Vercel caps the label at 63 characters: a longer branch is
truncated and given a hash, so `feat/13-some-long-description` can become
`<project>-git-feat-13-some-lo-5852d1-<team>.vercel.app`, which no rule
predicts. Don't construct it; read it from the Vercel bot's comment on the
pull request, or from the Vercel dashboard's deployments list for
`<project>`.

**Vercel tears down neither kind of preview.** The preview deployment and its
branch alias survive the merge *and* the branch deletion; nothing built into
Vercel cleans them up on its own.

Vercel collects nothing on this plan (Deployment Retention is a Pro feature
and most teams are on Hobby), so `.github/workflows/preview-prune.yml` does
it: when a pull request closes, it deletes that branch's previews across
every Vercel-deployed app, using `VERCEL_TOKEN` (a team-scoped token, a
repository secret — **add it, and record its expiry in README.md and
docs/data-governance.md, before the first pull request that deploys this app
closes**). Run it by hand (`gh workflow run preview-prune -f
dry_run=false`) to delete every preview whose branch no longer exists; the
default `dry_run=true` only lists them. Its preview modes never delete a
production deployment or a `develop` build, whatever they are asked.

Production history is trimmed the same way: every merge makes a production
deployment and Vercel keeps them all, so each close (and each manual run)
also runs `vercel-prune.mjs history`. It keeps the deployment each app's
alias points at, and the newest `KEEP_PRODUCTION` (3) built ones for instant
rollback; it leaves any built deployment newer than the live one and
anything still building (cancelled and failed records go whatever their
age), and deletes nothing if the alias lookup fails. `docs/data-governance.md`
should say why the token is safe to hold once this app serves anything real.

This is not automatically a non-exposure: `docs/data-governance.md`'s
decision about open previews was written for the placeholder shells this
base ships with. Revisit it for whatever `<app>` actually serves before
relying on it.
