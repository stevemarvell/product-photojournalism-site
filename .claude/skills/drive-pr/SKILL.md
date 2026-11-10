---
name: drive-pr
description: Given an open pull request number, drives it to green and merges it — poll checks, read both automated reviews, fix and reply to real findings (bounded), merge once clean, prune locally, then confirm the next smoke run. Use when asked to "drive PR #<n>", "get this PR merged", or to work an open PR to completion rather than hand it back half-checked.
---

# Driving a pull request to green

Driving a pull request to green — open → poll checks → read both reviews →
fix findings → reply → resolve → merge → prune — is a repeated, mechanical
sequence. This skill is that sequence, fixed, with every decision point
written as a rule rather than left to judgement, and every ceiling from
`docs/sops.md` SOP 1 declared up front.

**Cloud sessions refuse GraphQL**, and `gh pr …`, `gh issue …` and
`gh repo …` are GraphQL (#225). Every step below therefore uses the GitHub
MCP tools (`mcp__github__…`) first, with `gh api` (REST) as the fallback, in
a cloud session and a local one alike. `gh run …` is REST and is fine. If a
`gh` subcommand answers `HTTP 403: GitHub GraphQL is not available`, it is
this, not a permissions problem: use the REST route instead.

Takes one argument: the pull request number, `<n>`. The driver reads,
replies and merges; it does not commit to the pull request's branch. Fixes
in step 3 are committed and pushed by an `implementer` (the one exception is
a docs-only pull request the driver opened itself).

## The five steps

### 1. Poll checks until settled — ceiling: 40 polls × 30s

**If checks never register at all** — the bucket list stays empty well past
when `claude-code-review.yml` and CI normally start — check why before
polling blind:

```bash
gh api repos/{owner}/{repo}/pulls/<n> --jq '{mergeable, mergeable_state}'
```

(or `pull_request_read` with method `get`). `mergeable: false`, or a
`mergeable_state` of `dirty` or `behind`, is the usual reason: GitHub does
not register new checks against a head it cannot test against the base.
(`mergeable: null` only means GitHub has not worked it out yet; read it
again in a few seconds.) Fix it by merging `develop` into the branch — **not**
by rebasing, and never by force-pushing, which this repository's commands
deny:

```bash
git fetch origin develop
git -C <worktree-or-checkout> merge origin/develop   # resolve conflicts per SOP 8: union, not a choice, on tests
git -C <worktree-or-checkout> push
```

An `implementer` does this push, same as any other fix in step 3 — the
driver reads and reports, it does not commit to the branch itself (the
docs-only exception below still applies). Once the merge lands, `mergeable`
and `mergeable_state` clear and checks register normally; resume the poll
below.

"Settled" is a fact read from each check run's `status` and `conclusion`, not
a guess from reading output. Read them with `pull_request_read` and method
`get_check_runs` (the head commit's check runs), or with `gh api`, which this
loop does. The head is re-read on every attempt, because a fix pushed during
the wait changes it:

```bash
for attempt in $(seq 1 40); do
  sha=$(gh api repos/{owner}/{repo}/pulls/<n> --jq .head.sha) || { echo "attempt $attempt: could not read the head"; sleep 30; continue; }
  # A run that has not completed is "pending"; a completed one is "pass" for
  # success, skipped or neutral, and "fail" for anything else.
  if ! buckets=$(gh api "repos/{owner}/{repo}/commits/$sha/check-runs?per_page=100" --jq \
      '[.check_runs[] | if .status != "completed" then "pending"
        elif (.conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral") then "pass"
        else "fail" end] | join(" ")' 2>&1); then
    echo "attempt $attempt: gh failed: $buckets"; sleep 30; continue
  fi
  echo "attempt $attempt: $buckets"
  # Right after a push GitHub has registered nothing yet: the list is empty.
  # That means not yet settled.
  case " $buckets " in
    *" pending "*|"  ") sleep 30; continue;;
  esac
  break
done
```

- Any `pending` bucket, an empty list, or a failed `gh` call means not
  settled. These are the only states this loop treats as "keep waiting"; a
  failed call counts against the 40 attempts like any other.
- Otherwise it is settled: all `pass` means green, and any `fail` means at
  least one failed (a cancelled or timed-out run is a `fail`). Either way, stop polling and move to
  step 2.
- This runs longer than a single command should block for (40 × 30s = 20
  minutes) — launch it with `run_in_background` and wait for it, rather than
  a foreground call that will itself be interrupted.

**Ceiling hit** (still pending after 40 attempts): stop. Do not merge, do
not start fixing findings against checks that never finished. Go straight to
step 5.

### 2. Read both automated reviews

`claude-code-review.yml` posts two kinds of comment, both authored by
`claude[bot]`, both readable without guessing which is which:

```bash
# Top-level verdict comments — one titled "Reviewing PR #<n>" (code review),
# one titled "Security review of #<n>" (security review).
gh api repos/{owner}/{repo}/issues/<n>/comments \
  --jq '.[] | select(.user.login=="claude[bot]") | {id, body}'

# Inline findings, if either review had any — tied to a file and line.
gh api repos/{owner}/{repo}/pulls/<n>/comments \
  --jq '.[] | select(.user.login=="claude[bot]") | {id, path, line, body}'
```

Either review may not have run at all — `review-scope.mjs` skips a review
outside its scope, and the top-level comment for a skipped review will simply
be absent. Absence is not a finding to chase; only what was actually posted
is.

A review with nothing to say states that plainly: **"No findings"** in the
code review, **"does this change belong on develop as it stands: yes"** with
no bulleted findings above it in the security review. Treat a comment
matching that shape as answered already — nothing to fix, nothing to reply
to. Everything else — a numbered/bulleted finding, an inline comment — is a
finding to work in step 3.

**The reviews run once per pull request**, when it is opened, reopened or
marked ready, and again only when the `re-review` label is added (step 4).
They do not re-run on a push. So after a fix round the original comments are
still there and nothing new has been posted, and the driver has to tell a
fresh finding from one already answered. **A finding is answered when a reply
from this driver or its implementer already sits under it**: an inline comment
whose thread has a reply posted by someone other than `claude[bot]`, or a
top-level verdict comment that a later pull-request comment references (or
that step 3 resolved). A `claude[bot]` comment with no such reply is fresh.
List the inline ones still open with:

```bash
# A reply carries in_reply_to_id; a finding is open while nothing replies to it.
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate \
  --jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] as $answered
        | .[] | select(.user.login=="claude[bot]" and .in_reply_to_id == null
                       and ([.id] | inside($answered) | not))
        | {id, path, line, body}'
```

Anything that comes back is open. A top-level verdict comment has no thread, so
read the pull request comments in order: one that follows your reply is a new
review, one that precedes it is old.

### 3. Fix real findings and reply — ceiling: 2 rounds (SOP 1, "sending an agent back for rework")

One round is: read every open finding from step 2, then for each one:

- **Reproduce it before trusting it.** Run the command, read the exact line
  cited, or exercise the code path the finding describes — the same standard
  `docs/sops.md` SOP 3 holds this project's own controls to. A finding that
  does not reproduce, or that turns out to be a decision `CLAUDE.md` or
  `docs/sops.md` already records on purpose (SOP 5's "medium with a stated
  bound" is not a defect), is **not fixed**.
- **A finding that reproduces is fixed, by an `implementer`, not by the
  driver.** Send it back to the agent that wrote the PR (`SendMessage` to
  it). If that agent is gone, spawn a fresh `implementer` whose prompt names
  PR `<n>` as the one to continue, so its "Continuing an existing pull
  request" instructions apply: it pushes to that branch and opens no new
  PR. The brief carries the finding, the reproduction, and the instruction to make
  the smallest change that removes it, with a test per the "every behaviour
  change ships with a test" rule if the fix changes behaviour. The driver
  never edits code in the PR's worktree, even a one-liner: the coordinator
  that edits code is no longer checking it. Docs-only PRs the driver opened
  itself are the exception.
- **A finding the implementer reports as needing a person** (a credential, a
  dashboard, money, an open decision) usually has no issue behind it. Open
  one (`issue_write` with method `create`, or `gh api
  repos/{owner}/{repo}/issues -f title=… -F body=@<file> -f 'labels[]=<rank>'
  -f 'labels[]=human' -f 'labels[]=do not automate' -f 'assignees[]=<login>'`),
  rank it, label it `human` + `do not automate`, assign it, and link it in
  the reply to the finding. Write the body in the sections of `.github/ISSUE_TEMPLATE/story.md` (persona, story, Given/When/Then with unhappy paths, tech notes, testing notes, references), with any `Depends on #<n>` lines last. Write the body with a quoted heredoc, as for
  replies below: it quotes the implementer's report. A reply alone is not enough to clear
  step 4's merge gate.
- **Reply to every finding, fixed or not**, with what was done or why not:
  - Inline finding → reply in its own thread
    (`add_reply_to_pull_request_comment`, or
    `gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment_id>/replies -F body=@/tmp/reply.md`).
  - Top-level verdict comment → a pull request comment referencing which
    point it answers (`add_issue_comment`, or
    `gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@/tmp/reply.md`).
  - A thread, once answered, can be resolved: `resolve_review_thread`, or in
    a cloud session `POST /repos/{owner}/{repo}/pulls/<n>/ccr/comments/<comment_id>/resolve`.
  - Write the body to the file with a quoted heredoc (`cat > /tmp/reply.md
    <<'MD'`), never by interpolating into a double-quoted `--body "…"`:
    replies quote CI and review output, and `$(…)` or a backtick in that text
    would be executed by the shell.
- **Whether to ask for a re-review is decided once, in step 4** ("Re-review
  before merging"). Do not add the label here; note whether this round changed
  code for a `high` or `critical` finding or touched a control, because step 4
  asks.
- Send one brief per round covering every finding that reproduced, so the
  implementer pushes the round's fixes together and the branch never sits
  with a fix committed but unexplained. Reply to each finding once its fix
  is pushed.

The implementer runs `npm run verify` before it pushes (its own ceiling is
the 3 attempts `.claude/commands/ship.md` declares — this step does not get
a separate budget for that); the driver confirms it from the checks.

**Round 2 exists only if round 1 left something unresolved** — a finding
still disputed, a fix that did not turn `verify` green, or new findings
posted by a `re-review` the driver asked for after round 1 (the reviews do
not re-run on a push). Redo the same procedure once more.

**Ceiling hit** (something is still unresolved after round 2): stop. Do not
attempt a third round, do not merge with an unanswered finding. Go to step 5.

### 4. Merge and prune

#### Re-review before merging

This is the one place the condition for `re-review` is defined; everything else
points here. The reviews run once per pull request and never re-run on a push,
so a fix, or a pull request opened harmlessly and extended later, is not looked
at again unless the driver asks. A workflow cannot ask for it (a label added
with `GITHUB_TOKEN` starts no run); the coordinator's own token can. Ask when
**either** holds:

- a fix round (step 3) changed code in response to a `high` or `critical`
  finding, or touched a control (anything meant to *prevent* something: a
  header, a permission, a gate, a filter; SOP 3), since a control's fix is what
  a passing test does not prove; or
- the diff since the last review touches `.github/` or any path
  `scripts/review-scope.mjs` sends to the security review (everything that is
  not plain Markdown outside `.claude/` and `.github/`).

Otherwise reply to the findings and merge when `verify` is green. Work it out
with one block (`$BRANCH` is the pull request's head branch, `<n>` its number):

```bash
BRANCH=$(gh api repos/{owner}/{repo}/pulls/<n> --jq .head.ref)
HEAD=$(gh api repos/{owner}/{repo}/pulls/<n> --jq .head.sha)
LAST=$(node scripts/last-reviewed.mjs "$BRANCH"); code=$?
echo "last reviewed: $LAST (exit $code)"
if [ "$code" = 0 ] && [ "$LAST" != "$HEAD" ]; then
  # The file list comes from git, not the API: `compare` lists 30 files by
  # default and `gh api --paginate` does not work through the cloud proxy.
  if git fetch -q origin "$LAST" "$HEAD" && git cat-file -e "$LAST^{commit}"; then
    # --no-renames: a rename otherwise prints only its new path, so moving
    # a security-relevant file to a .md path would look like prose.
    git diff --name-only --no-renames "$LAST...$HEAD" | node scripts/review-scope.mjs --since
  else
    echo "re-review: needed (cannot fetch $LAST, probably force-pushed away)"
  fi
fi
```

`last-reviewed.mjs` counts a `claude-code-review.yml` run only if every review
job that ran succeeded and its `Check a review was actually produced` step
succeeded (one review skipped by scope is fine; one failed or cancelled is not;
a Dependabot run that skips every step and ends green is not). A failed run, a
cancelled one and a label-only run in which everything was skipped are not
"reviewed". Read the
result:

- **exit 2** (`gh` failed): an API error is not "no runs". Retry once; if it
  still fails, do not guess; stop and report.
- **exit 3, `none`, or exit 4, `pending`**: no review has finished, so the
  initial review is queued, running or has never worked. **Wait for the initial
  review** (step 1) and do not add the label. If it never arrives, run the
  checkers by hand (below).
- **exit 0 and `LAST` equals `HEAD`**: nothing changed since a review; only the
  fix-round condition above can still ask.
- **`re-review: needed`**, or `LAST` could not be fetched (a force-push removed
  it, so nothing is known about what changed): ask. An empty or unreadable diff
  also counts as needed. `review-scope.mjs --since` also treats a list of 300
  or more names as needed; that guard (`COMPARE_FILE_CAP`) is for a list taken
  from the API, which truncates, and is only a fallback here because `git diff`
  does not.
- **`touches .github/workflows/: true`**: the review action refuses a pull
  request that edits workflows, so a label would buy nothing. Run
  `security-checker` and `code-checker` by hand instead, as the `delegate`
  skill says, and reply to what they find.
- **A pull request authored by `dependabot[bot]`**: do not add the label (its
  runs have no review credential, `docs/data-governance.md`). Run the checkers
  by hand.

To ask, delete the label and then add it: `gh api -X DELETE
repos/{owner}/{repo}/issues/<n>/labels/re-review` (a 404 is fine), then `gh api
-X POST repos/{owner}/{repo}/issues/<n>/labels -f 'labels[]=re-review'`. A
cancelled run can leave the label on, and GitHub sends `labeled` only when a
label is *added*, so a stuck one would swallow the request. The workflow runs
both reviews once and removes the label when they finish; wait for the review
checks (step 1) and read them (step 2) before merging. A label costs about 5.6
billed minutes (scope, both reviews, and the `clear re-review` job, which bills
at least a minute).

Merge only when **both** are true, checked, not assumed:
- `npm run verify` is green on the branch's current head.
- Every finding from step 2 has a reply posted in step 3 (or needed none),
  and every one that needs a person has its own `human` issue linked in
  that reply.

Use `merge_pull_request` with `merge_method: squash`, or the REST route:

```bash
gh api -X PUT repos/{owner}/{repo}/pulls/<n>/merge -f merge_method=squash
```

The user's standing instruction is merge without asking once checks are
green — this is that instruction, executed, not re-asked.

Then prune locally (the remote branch is deleted automatically —
`delete_branch_on_merge` is a repository setting, see `CLAUDE.md`):

```bash
if [ "$(gh api repos/{owner}/{repo}/pulls/<n> --jq .merged)" = true ]; then
  git worktree remove <path-to-this-worktree>   # if this PR was driven from its own worktree
  git -C <main-checkout> fetch origin --prune
  git -C <main-checkout> branch -D <branch-name>
else
  echo "PR <n> is not MERGED; leaving the worktree and branch in place" >&2
fi
```

Everything destructive sits inside the one guard: nothing is removed until
GitHub says the merge happened. `-D`, not `-d`: a squash merge puts a new
commit on `develop`, so git never sees the branch as merged and `-d` refuses
every time. Forcing it is safe only because the guard has confirmed the PR
merged, and GitHub keeps the head at `refs/pull/<n>/head`, so nothing is lost.
On Windows, `git worktree remove` can fail with "Permission denied" while a
process still holds files in the worktree. Git has already unregistered it by
then, so delete the leftover directory once that process exits.

### 5. On hitting a ceiling: stop, comment, report

Whichever step's ceiling was hit (step 1's poll, step 3's rounds, or
`verify`'s own 3 attempts inside step 3):

```bash
cat > /tmp/drive-pr-stopped.md <<'MD'
drive-pr stopped: <which ceiling>, after <n> attempts/rounds.
<what was still failing>
<what is left to do>
MD
gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@/tmp/drive-pr-stopped.md
```

The quoted heredoc is the point: the failure text is CI output, and it must
reach the comment as text, not be expanded by the shell. (`add_issue_comment`
posts the same comment without the shell.)

Then report the same thing back. This is the record SOP 1 asks for: what was
attempted, what failed, what is left — on the pull request, where the next
attempt (person or agent) starts from it instead of from zero.

---

## After a merge: check the next `smoke` run — ceiling: 30 polls × 30s

Once step 4 has merged, `smoke.yml` fires on the push to `develop`. Confirm
it, rather than assuming the merge was fine because `verify` was:

```bash
sha=$(gh api repos/{owner}/{repo}/pulls/<n> --jq .merge_commit_sha)
for attempt in $(seq 1 30); do
  # One call per attempt, filtered by gh's own --jq rather than a jq binary:
  # jq is not installed on every machine this runs on, and without it every
  # poll fails and the loop runs to its ceiling reporting nothing.
  # An unfinished run's conclusion is "", not null, and `//` only replaces
  # null: the empty field vanished and `read` shifted the run id into
  # $conclusion. Every field is non-empty, so `read` always splits in three.
  run=$(gh run list --workflow smoke --branch develop --commit "$sha" -L 1 \
          --json databaseId,status,conclusion \
          --jq '.[0] // {} | "\(.status // "not-registered") \(.conclusion | if . == null or . == "" then "-" else . end) \(.databaseId // "-")"')
  read -r status conclusion id <<< "$run"
  echo "attempt $attempt: status=$status conclusion=$conclusion run=$id"
  [ "$status" = "completed" ] && break
  sleep 30
done
```

- **Pinned to the merge commit.** `--commit "$sha"` selects the run for *this*
  merge. Without it, the first poll can land before GitHub registers the new
  run and read the previous merge's result as this one's. Until the run
  appears, `status` is `not-registered`, which counts as not settled.
- **Settled** means `status == "completed"`. Anything else after 30 attempts
  (60 → wait, 30 × 30s = 15 minutes, matched to the workflow's own timeout)
  is the ceiling: stop and report that `smoke` never finished, without
  guessing at a result it never produced.
- **On `conclusion != "success"`**, pull the failing step's log tail and open
  an issue from it — the record this project's `smoke`-after-merge row has no
  other mechanism for:

Rank the new issue before filing it. It is `medium` unless the log tail shows
something that contradicts `docs/data-governance.md`'s bounds (real data
reachable, authentication changed unexpectedly). That ranks `critical` per
SOP 5, adds `security`, and the issue body says why. Set the labels
explicitly, since the command does not decide for you:

```bash
labels=medium            # or: labels=critical,security  -- see above
# $id is the run the loop above settled on -- no second query.
gh run view "$id" --log-failed > /tmp/smoke-failure.log
# The story template's sections (.github/ISSUE_TEMPLATE/story.md); the log tail is Tech notes.
printf '%s\n\n```\n%s\n```\n\n%s\n' \
  "## Persona
Maintainer of this repository.

## Story
As a maintainer, I want the smoke failure after merging #<n> fixed, so that the deployment is known good.

## Acceptance criteria
**Scenario: smoke passes**
- **Given** the fix is merged
- **When** the smoke workflow runs
- **Then** it passes

**Scenario: the fix does not hold**
- **Given** the smoke workflow still fails
- **When** the failing step is read
- **Then** this issue stays open with the new log

## Tech notes
Failing step's log tail:" \
  "$(tail -n 60 /tmp/smoke-failure.log)" \
  "## Testing notes
Add the test that would have caught it.

## References
Refs #<n>" > /tmp/smoke-failure.md
args=(); for l in ${labels//,/ }; do args+=(-f "labels[]=$l"); done
gh api repos/{owner}/{repo}/issues \
  -f title="smoke failed after merging #<n>" \
  -F body=@/tmp/smoke-failure.md \
  "${args[@]}"
```

(`issue_write` with method `create` does the same without the shell.) Keep the body in those sections, with any `Depends on #<n>` lines last.

This loop is deliberately separate from steps 1–5 above: it starts only
after a merge has actually happened, so a ceiling hit here never blocks or
un-merges anything — it only means the confirmation didn't complete, and
says so.
