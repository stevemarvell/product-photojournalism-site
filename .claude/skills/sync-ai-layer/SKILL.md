---
name: sync-ai-layer
description: Keeping the AI layer identical between boris (the master) and a repository built from it — which parts are shared (the engine), which stay per repository, and how to bring improvements up from a downstream repository before syncing down. Use when asked to sync, compare or reconcile .claude/, the SOPs or CLAUDE.md with boris or with a repository built from it.
---

# Syncing the AI layer

boris is the master copy of the AI layer. A repository built from it keeps the
shared files byte-identical, so a sync is a copy and a diff check, not a merge
of prose. Improvements found downstream come **up** to boris first, then go
back **down** — never edited only in the downstream copy.

## The parts

A product is assembled from three kinds of part, declared in place in
`catalogue.json` at the repository root rather than moved into folders:

- **The engine** — the loop: `.claude/`, `scripts/`, `.github/`,
  `telemetry/`, `docs/sops.md`, `labels.json` and a few root files. This is
  what this skill syncs. The list of engine paths is `engine.paths` in
  `catalogue.json`; read it there, it is not repeated here. The engine is
  an explicit allowlist (minus anything under a listed directory that another
  list claims, such as the two tests of the catalogue itself), and a test fails when a file in the repository is in
  none of the catalogue's lists.
- **Starters** — each app directory under `apps/` with the files it needs
  outside it. Copied once when a product is created, then the product's own;
  never synced.
- **Providers** — deploy code under `scripts/deploy/<name>/`. It is in the
  engine, so it syncs; its template files are copied once by `deploy:add`.

The catalogue's other lists say what is *not* synced: `seeded` (copied once,
then the product's own, such as `.claude/settings.json`, which an agent may
not edit — SOP 7), `generated` (written fresh for each product: its own
`CLAUDE.md`, `README.md`, `project.json`, `package.json` and
`docs/data-governance.md`) and `base` (this repository's alone).
`node scripts/assemble.mjs --target <empty dir> --name <name> --starter <s>`
builds a product tree from these lists.

A product records which boris commit its engine was copied from, as
`engine.commit` (a full 40-character SHA) in its `project.json`: `setup create`
writes it, and `node scripts/setup.mjs check` fetches boris's `develop` through the
product's fetch-only `boris` remote and reports "behind boris by N commits"
from it. That number is only true while the record is, so a sync moves it
(step 4).

One more shared thing is not a path: the block of `CLAUDE.md` between
`<!-- shared:begin` and `<!-- shared:end -->`. Everything outside it is the
repository's own.

A shared file never names the repository it sits in (naming boris as the
master is fine — that is the same everywhere). If a file has to, it isn't
shared.

## Procedure

Ceiling: one pass. Anything still different after it is reported, not looped
on.

1. **Measure.** For every path in the catalogue's `engine.paths` (read it
   from boris's `catalogue.json`), diff boris against the downstream
   repository (`git diff --no-index --numstat`). Byte-identical files need
   nothing.
2. **Classify each differing hunk:** generic (it belongs in the master),
   downstream-only (application content that leaked into a shared file — move
   it out of the shared file), or stale (the downstream copy is behind).
   Read the downstream repository's own log of findings if it keeps one.
3. **Up first.** Generic downstream improvements go into boris in a pull
   request, with any test that came with them. Strip incident narrative and
   the downstream repository's name as they come up.
4. **Then down.** Copy every engine file from boris's `develop`, replace the
   shared block of its `CLAUDE.md`, run `npm run verify` there, and run
   `node scripts/labels.mjs --repo <downstream>` so the downstream repository's
   labels match `labels.json`. Set `engine.commit` in the downstream
   `project.json` to the full SHA of the boris `develop` commit you copied from
   (`git rev-parse` it in boris at the moment of the copy, never from memory),
   and commit it in the same pull request: a copy that leaves the old SHA in
   place makes `check` report drift that is already gone. The copy also drops
   `smoke.yml`'s schedule, which only `deploy:add` writes: a product whose
   `project.json` has a `deploy` block reinstates it (`npm run deploy:add`
   again; `verify` fails until it does). Open a pull request;
   its body lists any file that is still intentionally different, and why.
5. **Check.** After both merge, re-run step 1: only files outside the
   catalogue's engine list may still differ. Then run
   `node scripts/setup.mjs check` downstream: its ℹ line should say "up to date with
   boris" if the copy was of boris's current `develop`.
