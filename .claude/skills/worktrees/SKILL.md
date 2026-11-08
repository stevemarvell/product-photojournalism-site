---
name: worktrees
description: How parallel agent work stays isolated in this repository — creating a worktree, what npm run bootstrap installs per-worktree, how end-to-end ports are derived so checkouts never collide, how previews behave per branch, and how to clean worktrees up afterwards. Read before starting a new worktree, cleaning old ones up, touching scripts/ports.mjs, or debugging an e2e port clash.
---

# Worktrees

Each agent works in its own worktree, so parallel work cannot collide. Claude
Code makes them under `.claude/worktrees/` (`EnterWorktree`, or the Agent tool
with `isolation: "worktree"`); by hand:

```bash
git worktree add ../<repo>-<name> -b feat/<name>   # <repo>: this repository's folder name
cd ../<repo>-<name> && npm run bootstrap
```

`node_modules` and `.venv` are per-worktree, not shared — `npm run bootstrap`
installs both toolchains and the Playwright browser.

## Ports

End-to-end ports are derived from the worktree directory name by
`scripts/ports.mjs`, so two checkouts never fight over a port. The app's e2e
config names the servers it needs (`ports(['api', 'web'])`), and each gets
its own band; set `E2E_<NAME>_PORT` (e.g. `E2E_API_PORT`) to override one.

## Previews

Nothing is deployed by default — `project.json` has no app with a `deploy`
block until `npm run deploy:add` adds one — so by default a branch gets no
preview at all. Once an app is deployed, a branch gets a Vercel preview of it
only when it changes what that app reads
(`scripts/deploy/vercel/vercel-ignore.mjs`). Each deployed app's preview is
independent: nothing pairs a branch's web preview with its API preview, so
which API a web preview calls is the application's business — its
`deployment` skill under `apps/<app>/.claude/skills/` says, once one exists. Vercel
tears no preview down; the `preview-prune` workflow deletes a branch's
previews when its pull request closes.

## Cleaning up

Every worktree here was made by a Claude session or one of its agents —
`.claude/worktrees/*` and any `../<repo>-*` sibling alike. None is someone
else's to leave alone. Audit them all, then remove what is finished.

**Never decide a worktree folder is empty from `ls -la`.** On this project's
Windows setup `ls -la` has read a folder that genuinely held files as empty —
see the note below. Use `find <dir> -mindepth 1 | head` or
`git -C <dir> status --short` to settle it instead; `stuck.mjs` already does
this (`fs.readdirSync`, never `ls`) for the folders it flags.

Before removing one, establish it is recoverable — by command, not by eye
(SOP 6):

- `git -C <worktree> status --short` — uncommitted files are the only thing
  git cannot give back. If there are any, check each against git
  (`git hash-object <file>` then `git cat-file -e <hash>`) before deciding.
- its branch's pull request is `MERGED`, or its tip is already on `develop`.

Then:

```bash
git worktree remove <path>        # add --force once the audit says it is safe
git branch -D <branch>            # -D: a squash merge never looks merged to git
git worktree list                 # confirm
```

On Windows `git worktree remove` can unregister the worktree and still fail
with "Permission denied" on its directory or on `.git/worktrees/<name>`. Git
has already unregistered it by the time this happens, so the removal is not
retried as `git worktree remove` again — a process (an editor, an indexer, a
leftover `node`/`uv` child) still holds a file open underneath. Wait for that
process to exit, then retry the *directory* deletion
(`rm -rf <dir> .git/worktrees/<name>`), not the git command. `git worktree
prune` alone often hits the same error, for the same reason.

### Sweep: `node scripts/stuck.mjs`

Run it as the last step of any cleanup pass, and whenever `work-backlog`
calls for it (its step 0). It lists, among other things, two things this
section is about directly: folders under `.claude/worktrees/` that
`git worktree list --porcelain` no longer tracks (an untracked leftover,
reported with its real entry count and whether it holds uncommitted
changes — never guessed from `ls`), and registered worktrees whose branch's
pull request has already merged. It only reports; acting on a finding is
this skill's procedure above, not something the sweep does itself.

### An unverified guess about why folders read as empty

**Unverified — flagged as a guess, not established.** The folders that
prompted this section read as empty under `ls -la` while still holding real
files underneath. One candidate explanation, never confirmed: this
project's checkout lives on a synced `M:` drive (a cloud-sync mount, not a
local disk), and a sync client can present a directory listing before the
sync has finished materializing every entry underneath it. Nothing here has
reproduced that mechanism directly — it is recorded so a future session does
not re-discover the same symptom and waste time assuming `ls` is simply
right.
