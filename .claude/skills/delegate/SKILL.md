---
name: delegate
description: How the coordinating session hands code to the implementer agent, and a review to code-checker / security-checker — what a brief must carry, how many to run at once, and how the result comes back. Read before spawning any agent from .claude/agents/, and before writing any application or build-loop code yourself (you shouldn't).
---

# Handing work to an agent

**The coordinator does not write code.** The session talking to the person
triages, briefs, checks results on their preview, replies to reviews and
merges. Application and AI-layer code — features, bug fixes, and the fixes
for review findings — is written by an `implementer` (`CLAUDE.md`). The
coordinator edits only docs, logs and issue text.

The reason is cost and independence. An implementer runs on Sonnet in its own
context; a coordinator writing code spends its own, larger context on it, and
a coordinator that wrote the code is no longer checking it.

`.claude/agents/` holds three roles. Each file is the agent's *standing*
instructions; it knows nothing about the task until the brief says so. The
role file carries the rules, the brief carries the task, the spawn carries the
model (each is pinned to Sonnet; pass `model` only for a deliberate trial;
the comparison behind that choice is recorded in the base repository).

| Agent | Does | Writes |
| --- | --- | --- |
| `implementer` | One change end to end: code, tests, `verify`, pull request — or continues an existing pull request. Never merges. | yes, in its own worktree |
| `code-checker` | Correctness and quality review of a diff or pull request. | nothing |
| `security-checker` | Exposure review against `docs/data-governance.md`. | nothing |

CI runs both checkers once per pull request, when it is opened, reopened or
marked ready, and again only when the `re-review` label is added; it does not
re-run on a push (`claude-code-review.yml`; when the driver asks for one is in
`drive-pr` step 4). Spawn one by hand only for a review CI cannot do — a pull
request that edits `.github/workflows/`, where `claude-code-action` refuses to
run, or one authored by `dependabot[bot]`. Give it **one combined hand review**:
a single brief to one `security-checker` agent that tells it to apply
`.claude/agents/security-checker.md` in full and then `code-checker.md`, and
to report the two sets of findings separately. It is one agent, not two, and
the security rubric is never cut down.

Never hand over an issue labelled `human`, `do not automate`, `blocked…` or
`template`. `scripts/triage.mjs` already excludes them; a hand-picked task gets
the same check.

**Ceiling: 3 implementers at once**, matching `MAX_ISSUES_PER_RUN` (SOP 1).
This is discipline; nothing counts running agents. Within it, **run them in
parallel only on issues whose paths do not overlap**
(overlap only produces contention warnings, `pr checks`), and **start no more
than the remaining usage window can finish**: an agent killed at a usage limit
wastes everything it spent. Each costs about 105k–165k tokens (SOP 4). Issues
that touch the same files go in **one brief and one PR**. The coordinator
relays only each agent's final report, not its progress (SOP 1).

**On a usage limit** (an agent or a review run stops on one): record what is
in flight (issues, PRs, agents) in the run's report, schedule one resume after
the reset time the limit states, and start no new work until then. Other
skills point here.

## The brief

An implementer starts cold. The brief must carry:

1. **The task**, and the issue number if there is one — the agent writes
   `Closes #<n>` from it.
2. **The done-when**, copied from the issue rather than paraphrased: when the
   issue follows the story template, its Given/When/Then scenarios are the
   done-when, one test per scenario, and its **Details to complete** are the
   inputs and decisions already made.
3. **The files it owns.** It is told to stay inside them, so a missing file
   becomes a report instead of a change. Two parallel agents never own the same
   file.
4. **What you already know**: the cause if you found it, what you ruled out,
   anything surprising. Do not make it rediscover facts.
5. **For a review fix:** the pull request number to continue, the finding,
   and how to reproduce it. The agent checks that branch out and pushes to
   it; it opens no new pull request (`implementer.md`, "Continuing an existing
   pull request").

Spawn it with worktree isolation (`isolation: "worktree"` on the Agent tool) so
its checkout, ports and branch are its own — see the `worktrees` skill.

## When it comes back

The report is a claim, not evidence. Its pull request is the work:

1. Read the diff. Check that it stayed inside its files and did what the brief
   asked — not only that `verify` is green. Read its
   "Decisions made" list: open questions it decided and recorded with the
   reason (SOP 6) rather than stopped for. Where it changed something a person
   would see, look at it on the preview (SOP 3, SOP 9).
2. Run `drive-pr <n>`. That polls checks, sends review findings back to an
   implementer, merges, and confirms smoke.
3. Rework goes back to the **same** agent (SendMessage) while it is alive; a
   fresh one is briefed to continue the pull request. At most **2 rounds**
   (SOP 1). After that, stop and report — do not finish it yourself.
4. If it stopped because the work needs a person (`implementer.md`, "When the
   work needs a person"), label the issue `human` + `do not automate`, assign
   it, and comment with what it found (SOP 2).
5. Clean up its worktree once the pull request merges (`worktrees` skill).
