# Standard operating procedures

How agent work is run in this repository. These are the procedures that govern
*how* work is done rather than *what* the code does — the things that are true
across every task, and that nobody should have to rediscover.

Each procedure states what it requires, what enforces it, and — where nothing
does — says so plainly. A rule nobody can check is a convention; calling it a
control is the failure SOP 3 catalogues.

---

## SOP 1: Every loop declares a maximum

**Every skill, command, and agent declares a ceiling on how many times it will
retry, and reports when it reaches it.**

An agent that retries until it succeeds has no upper bound on cost, and the
cost is not hypothetical: three subagents have died mid-task on session limits
here. A loop that stops and says *"I tried three times, here is what failed"*
is worth more than one that spends a budget silently and is killed halfway
through.

### What the ceiling means

On reaching the ceiling, **stop and report**. Do not continue, do not start
again from the top, and do not quietly reduce the scope to something that
passes. The report says what was attempted, what failed each time, and what is
left — so the next attempt, by a person or another agent, starts informed.

Reaching a ceiling is not a failure to hide. It is the procedure working.

Every ceiling here bounds cost — attempts, polls, rounds — not wall-clock
time; nothing in this repository enforces a time limit on a running agent,
so a loop under its attempt ceiling can still run long.

### The declared ceilings

| Loop | Ceiling | Where it is declared |
| --- | --- | --- |
| `verify` → fix → `verify` | 3 attempts | `.claude/commands/ship.md`, enforced by `.claude/hooks/verify-on-stop.mjs` |
| `verify` run and report | 1 attempt | `.claude/commands/gate.md` |
| Sending an agent back for rework | 2 rounds | this document |
| Implementer agents running at once | 3 | `.claude/skills/delegate/SKILL.md` |
| Polling a deployment in `smoke` | 40 × 15s per app for the freshness gate; 30 × 15s per app check | `scripts/smoke.mjs` (`GATE_ATTEMPTS`); each app's `smoke` script, per loop |
| Polling the pull request's check runs in `drive-pr` | 40 attempts × 30s | `.claude/skills/drive-pr/SKILL.md` |
| Polling the post-merge `smoke` run in `drive-pr` | 30 attempts × 30s | `.claude/skills/drive-pr/SKILL.md` |
| Issues worked in one `work-backlog` run | 3, re-triaged after each merge | `scripts/triage.mjs`, `MAX_ISSUES_PER_RUN` |
| Paging Vercel deployments in `preview-prune` | 20 pages × 100 per project | `scripts/deploy/vercel/vercel-prune.mjs`, `MAX_PAGES` |

Smoke is the model the rest of this follows. Every wait in an app's smoke
script is a
`for attempt in $(seq 1 30)` with an explicit `sleep`, an echo per attempt, and
a distinct message on exhaustion. The ceiling is visible in the file, the
progress is visible in the log, and running out is a specific failure rather
than a timeout. That is what a bounded loop should look like.

### What enforces this

**Today: nothing mechanical, for the model-driven loops.** SOP 1 is a
discipline that a session follows by reading it. Be honest about that rather
than writing a `max_iterations` key into frontmatter that no harness reads —
this repository's recurring failure is a control that is present, plausible,
and inert, and inventing a config key nobody consumes is precisely that shape.

Three loops *are* mechanically bounded:

- Smoke's waits, by `GATE_ATTEMPTS` and the `seq` bounds above.
- The rate limiter, at 120 requests per minute — see `docs/data-governance.md`.
- The fix-and-retry loop the stop hook drives.
  `.claude/hooks/verify-on-stop.mjs` blocks the end of a turn while `verify`
  is red, which is what creates that loop. It now counts consecutive blocks,
  per session, in a file outside the checkout. At the third red in a row it
  stops blocking, ends the turn, and reports the failure to the person. A green
  run, or a new turn from the person, resets the count. The ceiling is
  `MAX_CONSECUTIVE_BLOCKS`, and a test holds it to the three attempts
  `.claude/commands/ship.md` declares.

---

## SOP 2: Work that needs a person is labelled, not attempted

Some tasks cannot be finished by an agent, and the cost of finding that out by
trying is a wasted session and a plausible-looking report about work that did
not happen.

Where a human is genuinely required — testing something subjective, reading a
dashboard behind a login, making a purchase, deciding a trade-off that is not
ours to make — the issue carries **both** labels:

- **`human`** — a person has to do this part
- **`do not automate`** — and an agent should not start it first

and is assigned to the person who will do it.

Both labels, not one. `do not automate` alone says *stop*; `human` alone says
*someone should*. Together they say who, and that the stopping is deliberate
rather than an oversight.

An agent picking up work checks for these before starting. An agent that finds
one mid-task stops at that point and reports what remains, rather than
inventing a way around it.

---

## SOP 3: A control is verified where it runs

Not in the test suite. On the deployment.

Five controls in this repository have been present and running while doing
either nothing or far less than they claimed to, each with a green test suite
at the time:

| Control | Looked like | Actually did |
| --- | --- | --- |
| OTLP temporality | configured | exported nothing usable |
| OTLP endpoint | set by the workflow | overridden to `localhost` by a checked-out file |
| slowapi's `SlowAPIMiddleware` | installed and running | exempted every request |
| The rate limiter's client key | returning correct `x-ratelimit-*` headers | enforced 5× the configured limit |
| The rate limiter's counter | one budget, per its own docstring | one budget *per concurrent process*, and Vercel runs several |

Every one of them surfaced under load against a live deployment, never in the
suite. A rate-limit key can hold a full passing unit test suite while
enforcing several times its configured limit, because an in-process test
client is one process with one stable key and a deployment is neither —
only concurrent requests against the live thing show it. The same is true
one layer down: a counter kept in process looks like one shared budget in
its own docstring and is actually one budget *per execution environment*,
and a serverless deployment runs several. The general fix is to move the
ceiling somewhere genuinely shared — the platform's own edge, where
available — and to have `smoke` fire a real burst after every merge to
prove it holds, rather than trusting a unit test that structurally cannot
see the gap.

So when a change adds a control, exercise it against the deployed pull request
environment and put the real output in the pull request body. A test proves the
code does what you wrote. Only the deployment proves the deployment does.

---

## SOP 4: Spend context on the task in front of you

Usage on a subscription is drawn down by context size, not by effort. Claude
Code sends the whole conversation with every request, and prompt caching makes
that cheaper rather than free — the documentation is explicit that *"a one-line
question in a session that has been open all day still draws usage for the
whole conversation"*.

So the expensive habits are structural, not clever. In order of what they cost:

**Clear between unrelated tasks.** `/clear` costs nothing; `/compact` reads the
conversation it summarises and is itself a large request. Nobody can call
`/clear` on your behalf, so the status line at `.claude/statusline.mjs` makes
the moment visible instead: it shows the context share, both usage windows, and
says when to clear — loudest when the cache has gone cold on a large context,
which is the most expensive single message you can send. A session that has
run through four unrelated topics is re-sending the first three on every turn.
If you catch yourself saying "the only thing we are discussing is X", that was
the moment.

**Keep `CLAUDE.md` short.** It loads at session start, so it is in every
request of every session *and* every subagent. Specialised knowledge belongs in
a skill, which loads only when it is relevant — that is why the deployment,
docs-site and worktrees detail moved out of it. Target: under 200 lines.

**Filter verbose output in a hook, not a subagent.** A hook runs outside the
model loop, so it costs zero tokens; a subagent summarising the same log costs
whatever it spends. `.claude/hooks/filter-verbose.mjs` shrinks CI logs and
`verify` output before either reaches the conversation. The cheapest model is
no model.

**Spawn fewer agents.** Each one carries its own context window, loads
`CLAUDE.md`, and costs 57k–144k tokens on the evidence in
the model-tiering trial recorded in the base repository. Parallel agents multiply that directly; the
documentation puts agent teams at roughly seven times a standard session. Three
well-scoped agents beat seven overlapping ones, and cost less than half.
Fewer is not none: code still goes to an `implementer`. A Sonnet agent with a
focused brief writes code more cheaply than the coordinator does in its own,
larger context — the `delegate` skill.

**Model choice is the smallest of these.** Measured, it moved about 5%. It is
worth getting right — the model-tiering trial recorded in the base repository shows where a cheaper
model is safe and where it silently is not — but it is the last lever to reach
for, not the first.

### The other two levers the adoption document names

Step 3's row also names advisors and LSPs alongside model selection and
`CLAUDE.md` → Skills. Each of the four is either in use or recorded here as
not applicable with the reason, the same treatment given to earlier rows
that did not apply.

**Advisors: not applicable.** The [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
is a beta *Messages API* feature — a hand-rolled executor loop calls
`/v1/messages` with the `advisor-tool-2026-03-01` beta header so a cheap
executor model can consult a stronger one mid-turn, billing most tokens at the
executor's rate and only the consultations at the advisor's. It is not a
Claude Code setting: there is no `.claude/settings.json` key for it, and it
only pays off inside a custom agent loop built directly on the API. Every
agent in this repository runs through Claude Code's own Task/subagent
mechanism, not a hand-rolled Messages API loop, so there is no call site to
attach it to. **Trigger:** this repository starts orchestrating its own agents
directly against the Messages API rather than through Claude Code.

**LSPs: in use.** Claude Code's [code intelligence plugins](https://code.claude.com/docs/en/discover-plugins#code-intelligence)
(`pyright-lsp`, `typescript-lsp`, from the official marketplace) are enabled
project-wide by `enabledPlugins` in `.claude/settings.json`. They are free and
need no signup. A plugin does not install its own language server, and it only
looks for one on `$PATH`, so `npm run bootstrap` installs `pyright` and
`typescript-language-server` globally on any machine that lacks them
(`scripts/lsp.mjs`). Without them, the plugin fails quietly: an `Executable not
found in $PATH` note in the `/plugin` Errors tab, and no build failure, which
is the present-but-inert shape SOP 3 exists to catch. So the first check on a
new machine is that tab, not the settings key. The LSP tool is unavailable in
cloud sessions, so there navigation still costs grep-and-read.

---

## SOP 5: One scale ranks everything

`critical`, `high`, `medium`. Three labels, and they are the only ranking in
this repository.

| Label | Means |
| --- | --- |
| `critical` | Do first. Wrong answers, real exposure, or work blocked until it lands. |
| `high` | Do next. A real defect, bounded today by something written down. |
| `medium` | Do eventually. Worth doing; nothing is wrong while it waits. |

### Why one and not two

Severity and priority are different questions everywhere else: how bad is it,
and when do we do it. Keeping both means two rankings on one issue, and two
rankings disagree — a `p3` marked `critical` is a sentence with no reading.
When they disagree the label wins, because the label is what a query sorts by
and what a person sees in the list, and the prose in the body is what gets
forgotten.

This repository has one author and one queue. The answer to "how bad is it"
*is* the answer to "when do we do it", so it is written once.

A severity written as prose in the issue body is not a second scale, it is an
unlabelled one: "Severity today: low", "Honest severity: low", "Severity:
moderate" are three spellings of a ranking the labels already carry. Rank in
the label.

### What a ranking below `critical` has to say

That something bounds it, and what would void that.

This is the part the single word cannot carry, so the body carries it, and it
is the same shape `docs/data-governance.md` uses for the whole deployment: a
posture, what bounds it, and the trigger that voids the decision.

- A CI credential exposure ranks `high` because one person has write access.
  The trigger is named: a second one gets it.
- An exposed schema ranks where it does because it describes invented data.
  The trigger is the same one above.
- `docs/data-governance.md` is defensible because the deployed apps serve no
  real data. The trigger is real data landing.

A `medium` with no stated bound is a guess wearing a label. The bound is the
argument; the label is only its conclusion.

### External scales are quoted, not adopted

`npm audit` says `moderate`. A CVE says `high`. Those are other people's
scales, computed without knowing that the data here is invented and the API
is public on purpose — an advisory can need a major version bump to fix and
still endanger nothing in this repository. Quote them, attribute them, and
then rank the issue yourself.

### What enforces this

Nothing mechanical, and the same applies to both reviewers — the rubrics in
`.claude/agents/` name the three words, but nothing rejects a review that coins
a fourth. What holds it together is that there is one place to put a ranking:
an issue cannot be one thing in its labels and another in its second paragraph
if only the label ranks.

---

## SOP 6: Decide and act; report after

Pick the option you would have recommended, do it, and say what was done and
why. A recommendation offered back as a question is work handed back: the
answer was already in the recommendation, and asking costs a round trip to
arrive at it.

Asking is not the cautious choice. It reads as deference, so it never draws the
scrutiny a risky action draws, and that is what makes it expensive.

### The test is recoverability, not scope

What still stops and asks is narrow, and it is not "is this big" or "was this
literally requested":

- **work nobody can get back** — an unmerged branch, an unpushed worktree, data
  with no copy;
- **money** — a plan upgrade, a purchase, anything metered past a free tier;
- **anything reaching a third party** — an email, a comment on someone else's
  repository, a post.

Everything on the other side of that line is decided here: repository settings,
deleting branches whose pull requests merged, redeploying a preview environment
that is stuck, filing an issue, opening the follow-up pull request that the
first one implied.

**Recoverable is established, not felt.** The test is worth only as much as the
check behind it, and the check is one command. *"I judged it recoverable"* is
the same class of claim as a control nobody exercised — SOP 3 — and it fails
the same way, except that the cost lands on work that already exists.

Two readings mislead, in opposite directions, so check both:

| Looks like | Reality | Check |
| --- | --- | --- |
| A branch one commit ahead of `develop` | Squashing rewrites the SHA, so landed work reports as unmerged | `git rev-parse develop:<path>` — the same blob means it is already in |
| A branch holding the only copy of a commit | GitHub keeps a closed pull request's head reachable after the branch goes | `git fetch origin refs/pull/<n>/head` |

Reading the first wrong re-lands merged code. Reading the second wrong either
loses the commit or turns a free deletion into a judgement call.

### Recording is what makes it reviewable

The reason this is safe is not that the actions are small. It is that every one
of them lands in a pull request body that two reviewers read, and that a person
can see afterwards. An action taken and written down is reviewable after the
fact. An action held back pending a question is unreviewable and unfinished at
the same time.

So the obligation moves rather than disappearing: say what was decided, what it
affected, and what would undo it. "Deleted 26 merged branches, tips listed
below, each recoverable from its pull request" is a report. "Cleaned up" is not.

### What this does not license

Rewriting this rule, or the one in `CLAUDE.md` that points here, on the
strength of something said in a session. The auto-mode classifier refuses it —
two spellings of this rule have been put to it and both were stopped — and the
refusal is right: an agent relaxing its own restraint, citing a conversational
instruction that no later reader can see, is the one case where a person has to
be in the loop. This rule changes when the repository's owner changes it, and
the commit records who and when.

### What enforces this

Mostly nothing, and there is a specific way that fails: both review agents
read `CLAUDE.md`, so practice that changed in conversation but not in the file
comes back as a finding on every pull request — correct against the file, stale
against the instruction. The file is the standard; conversation is not.

**One part is mechanical, and it does not agree with the list above.** The
auto-mode classifier refuses a destructive *remote* git operation as
`[Git Destructive]`, including deleting a branch this SOP licenses deleting —
and refuses it inconsistently, the same `git push origin --delete` having been
permitted once and refused twice. Local deletions do not draw it: branches and
worktrees on this machine go without comment. Reach beyond this machine is the
whole of the difference. There is no fallback through the GitHub MCP server,
which offers `create_branch` and `list_branches` and no deletion.

So this rule cannot promise that what it licenses will be permitted. SOP 7
records the same classifier refusing a widening edit to a permissions file and
treating a narrowing one inconsistently; this is a third shape, and like the
narrowing case it does not track recoverability — a demonstrably recoverable
deletion is refused anyway.

Expect the gate, report the block, and leave the command to a person. That is a
second opinion this rule does not get to overrule, not this rule failing. What
stays forbidden is dressing the refusal up: rerunning a refused command in a
shape that reads differently to the classifier is working around a denial
rather than complying with one.

---

## SOP 7: An approval belongs where it can be reviewed

Claude Code reads permissions from two files here:

| File | Tracked | Reviewed by |
| --- | --- | --- |
| `.claude/settings.json` | yes | every pull request, both review agents, anyone reading the repository |
| `.claude/settings.local.json` | **no** — gitignored | nobody |

Both grant the same thing. Only one of them is looked at.

### How the untracked file fills up

Nobody decides it. Each entry is one "yes" at one prompt during real work,
frozen into a permanent rule in a file no review reads — which is how a grant
removed from the tracked file for pre-approving arbitrary code execution
reappears in the local one by a shorter route, as `Bash(python -)`.

Dead entries are the other half, and they are most of why this matters: a merge
of a pull request long closed, pushes to deleted branches, `curl`s against
hostnames two migrations out of date. Harmless in themselves, they are the
noise that makes a dangerous entry hard to see.

### The boundary

**Tracked, in `.claude/settings.json`:** anything the project's own loop needs,
on any machine, for any person or agent. `npm run *`, the `uv run --directory
apps/api` commands, git and `gh` operations, `curl` against localhost and the
deployed hosts. If every session here would approve it, it belongs where the
reviewers see it.

**Local, in `.claude/settings.local.json`:** genuinely machine-specific
convenience, and nothing else. A path that exists on one laptop; a tool nobody
else here runs.

**Neither:** anything that reads a secret or changes what the world can reach.
`vercel env pull` writes a project's environment variables to a local file —
whatever that project has configured, secret or not. Leave it prompting. A
prompt on a rare command costs a second; a
pre-approval on it costs the ability to notice.

The failure mode this rule exists to prevent is the one that happened: the
tracked file is too narrow, so approvals accumulate in the local file instead,
and the local file is where permissions go to escape review. Widen the tracked
file rather than letting the untracked one absorb the difference.

### What enforces this

**The auto-mode classifier, in one direction only.** What is observed, and
nothing wider:

- **Widening is refused.** An agent adding to the tracked file is stopped. An
  agent changing its own permission grants is an agent deciding what it is
  allowed to do, and *"I was only tightening it"* is what the unsafe version
  says too. The same gate refuses edits to `CLAUDE.md`'s restraint rule
  (SOP 6).
- **Narrowing is inconsistent.** Removing dead entries went through once, on
  explicit instruction (#123). Another time it was refused as
  `[Self-Modification]` (#201): an agent dropping a dead deny entry for a
  retired deploy CLI was stopped, and the owner removed it by hand. Removing a grant
  cannot expand what an agent may do, but the gate does not reliably see that.

So this is an observation and not a guarantee: expect a widening edit to be
stopped, and expect either outcome for a removal. A rule predicting a refusal
that does not happen is the shape this document exists to avoid.

So *adding* a permission is `human` work by construction rather than by
preference. What an agent can do is audit both files, report, and propose
taking dead entries out of the tracked one. When the gate refuses a removal,
it goes to the owner, as #201 did.

### Tuning the classifier: not tuned

Decided on 2026-10-27 (#153), with the owner handing the decision to the
coordinating session. The auto-mode classifier stays at its defaults, and no
agent tunes it.

- **Why not tune it.** Six refusals of four kinds have been observed here:
  a remote branch deletion, twice (SOP 6); an edit to `CLAUDE.md`'s restraint
  rule, twice (SOP 6); a widening permissions edit (above); and #201's
  narrowing edit, which a similar earlier case let through. Each cost one
  hand-off to the owner, and none exposed anything. The gate errs toward
  refusing, the safe direction. Six data points, two of them inconsistent with
  earlier cases that went through, are too few to set a looser rule from.
- **Why an agent may not.** Tuning is an agent adjusting the gate that governs
  it. The argument above applies unchanged.
- **What would reopen it.** Refusals frequent enough to stall unattended work,
  such as a `work-backlog` run stopping on one, or the classifier permitting
  something it should refuse. Either is a new issue for the owner, with the
  transcript.

The `/fewer-permission-prompts` skill does the tidying mechanically, reading
transcripts to find the commands actually run, adding what is missing and
removing what has gone stale in the same pass.

---

## SOP 8: A conflict between two branches is resolved as a union, not a choice

**When two branches conflict, git offers a choice between two sides. For source
that is usually right. For tests it usually is not, and taking a side there is
how this repository loses a control it has already paid for.**

### Why a test conflict is not a choice

A source conflict usually has a right answer. A test conflict usually does not:
when both sides are *additions*, both are correct, and picking one deletes a
proof somebody already wrote.

Taking a side per file is how that happens:

```
git checkout --ours   scripts/review-scope.mjs
git checkout --theirs apps/web/src/review-scope.test.ts
```

On a run of exactly this shape, that resolution dropped assertions, including
ones proving the governance half of a fix that had just merged. The
behaviour stayed correct and the suite stayed green, fewer tests and all —
`verify` would have stayed green with it.

That is this repository's signature defect, a control present and inert,
arriving by a route none of SOP 1–4 covers: written correctly, merged
correctly, then quietly removed by a conflict resolution.

### The rule

- **Source:** pick the better change, deliberately. One of them usually is.
- **Tests:** keep both sides unless one is genuinely the same test twice.
  A conflict between two additions means two people each proved something.
- **Anything removed on purpose** says so in the pull request body on a line
  beginning `Removes tests:`.

Never `git checkout --ours` or `--theirs` on a whole test file. It resolves the
conflict by deleting evidence, and nothing in the file's own suite can tell.

### What enforces this

The `test census` check (`scripts/test-census.mjs`) counts declarations on
both sides of a pull request and goes red when the head has fewer without that
line. It is the backstop, and it counts declarations rather than results — a
row deleted from inside an `it.each` table is still invisible.

The `contention` check (`scripts/pr-contention.mjs`) is the earlier warning.
It three-way merges every open pull request against the base tip and against
every other open head, and comments when two collide — naming which of the
conflicting files are test files, because those are the ones this SOP is about.
It reports and does not block: two colliding pull requests are not a defect in
either, and a red check on both is one neither author can clear alone.

Neither sees a collision with no textual overlap: one branch can add a field
to a response, another can pin that response's exact JSON, and the merge is
clean in both directions — two branches sharing a *contract* is the harder
case than two sharing a file, and only CI catches it.

---

## SOP 9: A web-facing change is driven, not only tested

The adoption document the base repository holds lists, among step 2's guardrails, Claude-powered
end-to-end verification — looking at the rendered app, not only asserting
against it. The Playwright specs against the built bundle (`vite preview`
plus a real `uvicorn`, never a mock) are the right foundation and
structurally cannot cover this. A pixel assertion on spacing or layout passes
when the number is right and says nothing about whether the thing it is
meant to guarantee — content fitting on screen, an empty state reading
sensibly to a person looking at it — is actually true.

### What this is not

Not a visual-regression pipeline, not screenshots in CI, not a new gate
blocking `verify`. Both are a later-stage cost this solo repository does not
carry yet. This is one instruction: look before claiming.

### The procedure

On a pull request touching `apps/web`, or an `apps/api` response shape a
person would notice by eye: drive the built app with the `run` skill —
start it, or open its PR preview — and look at the actual result of the
change. Put what was observed in the pull request body, specifically: not
"looks fine" but the thing looked at and what was seen. *"Loaded the PR
preview, the new panel renders where it should, and the empty state reads
'…' when nothing matches"* is a report. "Looks fine" is not, for the same
reason "cleaned up" is not a report under SOP 6.

A visual defect a pixel assertion cannot see is not hypothetical: a layout
test can pass unchanged whether or not the thing it measures actually fits
the viewport it is meant to guarantee it does.

### What enforces this

Nothing mechanical, and it would be dishonest to claim otherwise, in the
company SOP 1 keeps. This is discipline, the same category as SOP 4's
context budget. What it changes is what a review reads for: a pull request
claiming visual correctness with nothing looked at is the same shape SOP 3
exists to catch — a control that looks like it ran and did not.

---

## SOP 10: A permission gate is not an execution sandbox

The auto-mode classifier and the two permission files (SOP 7) decide
*whether* a command runs. Neither one constrains what it can reach once it
does — same machine, same filesystem, same credentials, same network. The
concrete case: the two review jobs in `.github/workflows/claude-code-review.yml`
read a pull request's *head*, which `docs/data-governance.md` already
treats as untrusted, with a Bash tool that can run `gh pr diff` and `gh pr
view`.

### What runs sandboxed today

Both review jobs. Each carries a new pair of steps, right after the
telemetry one:

```yaml
- name: Install the sandbox's OS dependencies
  run: sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends bubblewrap socat
- name: Enable the sandbox for this session's Bash tool
  run: node scripts/write-ci-sandbox-settings.mjs
```

Claude Code's own sandbox — the built-in one, not the standalone
`sandbox-runtime` package, which wraps a whole process rather than one tool
inside a session Claude Code already runs — puts `bubblewrap` around every
Bash, PowerShell, and Monitor command. The GitHub-hosted Ubuntu runner does
not carry `bubblewrap` or `socat` by default, so the first step installs
them; the second writes `sandbox` settings into the same out-of-checkout
file `scripts/write-ci-telemetry-settings.mjs` already writes, for the same
reason that file's own header gives: this job checks out a pull request's
*head* to review it, and `claude-code-action` deletes and restores
`.claude` from the *base* branch immediately before the CLI starts, so
nothing written under the checkout survives to be read.
`scripts/write-ci-sandbox-settings.mjs` merges a `sandbox` key into that
same file rather than writing a second one, because nothing here
establishes that the action's `--settings` flag can be given twice.

The configuration: `enabled: true`, `failIfUnavailable: true`,
`allowUnsandboxedCommands: false`, `network.strictAllowlist: true`,
`network.allowedDomains` limited to the GitHub hosts `gh pr diff` and
`gh pr view` need. `failIfUnavailable` is the choice that matters most —
the sandbox's own default when a dependency is missing is to warn and run
unsandboxed, which is exactly the "present, configured, and quietly inert"
shape SOP 3 exists to catch. Failing the job instead turns a missing
package into a build failure somebody has to fix, not a review that ran
open the whole time. `allowUnsandboxedCommands: false` removes the escape
hatch that lets a blocked command retry outside the sandbox — this job's
`--allowedTools` already narrows its Bash tool to two read-only `gh`
commands, so a command the sandbox cannot run is a command this job should
not run at all, given the two credentials the step holds.

**Evidence goes in the pull request body that adds this SOP**, per SOP 3:
the log line where the sandbox initialises on the actual CI run, not a
unit test asserting the settings object has the right shape. A test
proves `ciSandboxSettings()` returns `{enabled: true, ...}`; only the
runner proves bubblewrap is there and Claude Code used it.

### What is deliberately not sandboxed

**Local sessions on the maintainer's machine, which is Windows 11,
native.** Claude Code's sandbox runs on macOS, Linux, and WSL2 only —
native Windows is unsupported, and the only way to get it here would be
running the whole session inside a WSL2 distribution, which is a bigger
change than this issue's scope and not one to make silently as a side
effect of closing it.

This is a legitimate outcome — a note records why this project deliberately
runs without one — for the half of the gap CI cannot close. It is bounded
the same way the rest of that gap is bounded: one person has write access,
the deployed apps serve no data at all (`docs/data-governance.md`), and the
realistic risk on a laptop session is a prompt-injected agent rather than a
malicious one. CI was the sharper case *because* it is the one place here
that already reads content nobody here wrote — a laptop session reads
whatever the person at the keyboard points it at, which is a different, and
today still open, question. **What would void this:** a second person with
write access, real data, or a laptop session routinely running third-party
content it fetched at run time — a dependency README, a fetched page. Any
of the three makes running Claude Code inside WSL2 (or accepting the loss
of the platforms that still lack a sandbox) worth doing rather than
deferring.

Nothing here changes `.claude/settings.json`'s own `sandbox` key, which
would be the way to turn this on for interactive sessions on a supported
platform. That is a separate decision — whether to require it project-wide
now that CI proves the mechanism works — and belongs with whoever next
edits that file, not folded into this one silently.

### What enforces this

**In CI: partially mechanical.** `failIfUnavailable: true` makes a missing
dependency a job failure rather than a silent fallback — that half is
real. Nothing here stops a future edit to `claude-code-review.yml` from
deleting the two sandbox steps entirely; the workflow-validation rule
`scripts/assert-review-ran.mjs` documents (a pull request changing
`.github/workflows/` gets no automated review of that change at all) means
a change removing the sandbox is exactly the kind of change that ships
without one. **Locally: nothing.** Sandboxing a laptop session, on a
platform where it is available, is discipline — the same category SOP 1
places the model-driven loops in.
