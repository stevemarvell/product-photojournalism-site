---
name: release
description: How the coordinator releases a product built from this base - cut a Release pull request from develop to main, wait for the owner's go, merge with a merge commit, tag and create the GitHub Release, confirm production smoke; plus the hotfix, back-merge and rollback routes. Use when asked to "release", "cut a release", "ship develop to production", "hotfix", or "roll back".
---

# Releasing

The scheme, and why, is `docs/releases.md`: `main` is production, `develop` is
staging, and nothing reaches `main` without the owner's `go`. This skill is the
coordinator's procedure. All GitHub calls are REST (`gh api` or the MCP tools):
`gh pr`, `gh release` and `gh issue` are GraphQL, which cloud sessions refuse
(#225). Ceiling (SOP 1): wait for `go` at most one run; do not poll for it.

## Cut

1. `git fetch origin`; if `origin/main` has nothing `origin/develop` lacks, stop:
   nothing to release.
2. `node scripts/release.mjs plan` prints the next tag and the notes (every
   pull request behind what `develop` has and `main` lacks, with links).
3. Open a pull request `develop` into `main`, titled `Release <tag>`, with the
   notes as the body (`create_pull_request`, base `main`). If one is open
   already, update its body instead of opening a second.

## Wait for go

`node scripts/release.mjs go --pr <n>` exits 0 only when the owner's login
commented `go` after the head's latest commit, or the owner merged it (a new
commit after `go` voids it). A `go` from anyone else is ignored.
Exit 1: leave the pull request open and report "release #<n> waiting for the
owner". Never merge it yourself without a `go`. Do not assign or label
anything for this: the owner's comment is the gate.

## Merge, tag, confirm

1. Merge with a **merge commit** (`merge_pull_request`, `merge_method: merge`),
   not squash, passing `sha` = the head `release.mjs go` printed, so GitHub
   refuses it if the head moved after the owner's `go`.
2. `node scripts/release.mjs tag --pr <n>` tags the merge commit
   `vYYYY.MM.DD` (`-2`, `-3` for more that day) and creates the GitHub Release
   with the same notes.
3. The push to `main` starts `smoke`; find the run (`gh run list --branch main`)
   and wait for it. Green means production is serving that commit. Red: report
   it, with the rollback route below; do not retry the release.

## Hotfix

Branch `hotfix/<slug>` from `main`, fix it with a test through an
`implementer`, open a pull request into `main`, and wait for `go` as above.
Merge with a merge commit, tag, confirm production smoke. Then, the same day,
open a pull request `main` into `develop` (the back-merge), and merge it with a
merge commit once green.

## Rollback

Only when the owner asks, or production smoke is red after a release.
1. Vercel Instant Rollback to the previous production deployment (the owner
   does this in the dashboard, or ask the Vercel MCP `request_rollback`).
2. A revert pull request on `main` with the owner's `go`, then back-merge it.
Say plainly in the report that step 1 is live and step 2 is pending.
