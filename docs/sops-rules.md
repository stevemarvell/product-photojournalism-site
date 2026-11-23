# Standard operating procedures: the rules

The rules alone, one section per SOP, for an agent that starts cold. The
reasoning, evidence and history are in [`docs/sops.md`](sops.md); open it only
for the SOP your task touches. SOP numbers are the same in both files.

## SOP 1: Every loop declares a maximum

Declare a ceiling on every retry loop, and report when you reach it. On
reaching it, stop and report what was attempted, what failed each time and what
is left. Do not start again from the top. Do not quietly shrink the scope to
something that passes. A ceiling bounds cost (attempts, polls, rounds), not
wall-clock time. Mechanically enforced: `verify` → fix → `verify` (`verify-on-stop.mjs`), the
`work-backlog` attempt tally (`triage.mjs`), `smoke` and `preview-prune`. Every
other row is discipline.

| Loop | Ceiling | Where it is declared |
| --- | --- | --- |
| `verify` → fix → `verify` | 3 attempts | `.claude/commands/ship.md`, enforced by `.claude/hooks/verify-on-stop.mjs` |
| `verify` run and report | 1 attempt | `.claude/commands/gate.md` |
| Sending an agent back for rework | 2 rounds | this document |
| Agents running at once | 3 unless the owner sets another number for the run, on non-overlapping paths only; fewer as usage nears its limit, and none started that the remaining usage window cannot finish | `.claude/skills/delegate/SKILL.md` |
| Polling a deployment in `smoke` | 40 × 15s per app for the freshness gate; 30 × 15s per app check | `scripts/smoke.mjs` (`GATE_ATTEMPTS`); each app's `smoke` script, per loop |
| Polling the pull request's check runs in `drive-pr` | 40 attempts × 30s | `scripts/wait-checks.mjs` |
| Polling the post-merge `smoke` run in `drive-pr` | 30 attempts × 30s | `scripts/wait-smoke.mjs` |
| Issues worked in one `work-backlog` run | No count. The maximum is the usage window: the run re-triages after each merge and continues until triage lists nothing, or usage reaches its limit, then records what is in flight and schedules one resume after the reset | `.claude/skills/work-backlog/SKILL.md`, `.claude/skills/delegate/SKILL.md` ("On a usage limit") |
| Pull requests parked at a `drive-pr` ceiling in one `work-backlog` run | No count; the run goes on to the next independent issue and reports each parked pull request | `.claude/skills/work-backlog/SKILL.md` (step 3), `scripts/parked.mjs` |
| Failed attempts (no pull request) recorded on one issue by `work-backlog` | 2, counted from `<!-- backlog-attempt -->` comments on the issue, then it is labelled `human` and `do not automate` and triage lists it under Skip whatever its labels. Enforced in `scripts/triage.mjs` (tested), so a resumed run cannot lose the tally; writing the comment and label is the loop's discipline | `.claude/skills/work-backlog/SKILL.md` (steps 2 and 3), `scripts/triage.mjs` |
| Paging Vercel deployments in `preview-prune` | 20 pages × 100 per project | `scripts/deploy/vercel/vercel-prune.mjs`, `MAX_PAGES` |

Nothing verifies a push to `develop`; never push there directly.

Full text: [SOP 1](sops.md#sop-1-every-loop-declares-a-maximum).

## SOP 2: Work that needs a person is labelled, not attempted

Label an issue that needs a person (subjective testing, a dashboard behind a
login, a purchase, a trade-off that is not ours) with both `human` and
`do not automate`, and assign it. Write its Details to complete as
instructions: numbered steps, exact values, what to comment back; a secret is
entered by the person and never goes in the repository, an issue or a chat. Before starting work, check for these
labels. On meeting one mid-task, stop there and report what remains.

Full text: [SOP 2](sops.md#sop-2-work-that-needs-a-person-is-labelled-not-attempted).

## SOP 3: A control is verified where it runs

A passing test is not evidence that a control works. When a change adds or
alters a control, exercise it against the deployed pull request environment and
put the real output in the pull request body. An in-process test client is one
process with one key; a deployment is neither.

Full text: [SOP 3](sops.md#sop-3-a-control-is-verified-where-it-runs).

## SOP 4: Spend context on the task in front of you

Context size draws usage. Clear between unrelated tasks. Keep `CLAUDE.md`
under 200 lines; put specialised knowledge in skills. Filter verbose output in
a hook. Spawn fewer agents (about
105k to 165k tokens each), but still send code to an `implementer`. Choose the model
last; it is the smallest lever.

Full text: [SOP 4](sops.md#sop-4-spend-context-on-the-task-in-front-of-you).

## SOP 5: One scale ranks everything

Rank with `critical`, `high` or `medium` labels only. `critical`: wrong answers, real
exposure, or work blocked. `high`: a real defect, bounded today by something
written down. `medium`: nothing is wrong while it waits. Never write a severity in prose. When
label and body disagree, the label wins. A ranking below `critical` states what
bounds it and what would void that bound. Quote external scales (`npm audit`,
CVE), then rank it yourself.

Full text: [SOP 5](sops.md#sop-5-one-scale-ranks-everything).

## SOP 6: Decide and act; report after

Pick the option you would recommend, do it, and report what and why. End no
turn with a question or an offer. Stop only for work nobody
can get back, money, or anything reaching a third party, and open a human issue
(SOP 2). Establish recoverability with a command, not by eye: check
`git rev-parse develop:<path>` (squashing rewrites SHAs) and
`git fetch origin refs/pull/<n>/head`. Record what would undo it. Never rewrite this rule on
the strength of a conversation. If the classifier refuses a remote branch
deletion, report it; do not rephrase the command.

Full text: [SOP 6](sops.md#sop-6-decide-and-act-report-after).

## SOP 7: An approval belongs where it can be reviewed

Put permissions every session needs in the tracked `.claude/settings.json`,
machine-specific convenience only in `.claude/settings.local.json`, and
anything that reads a secret or widens reach in neither. Never widen your own permissions: adding one is `human`
work. Report dead entries and propose removing them. The classifier is
deliberately untuned (#153); refusals that stall unattended runs mean a new
owner issue with the transcript.

Full text: [SOP 7](sops.md#sop-7-an-approval-belongs-where-it-can-be-reviewed).

## SOP 8: A conflict between two branches is resolved as a union, not a choice

For source, pick the better change deliberately. For tests, keep both sides
unless one is the same test twice. Never run `git checkout --ours` or
`--theirs` on a whole test file. State any deliberate removal in the pull
request body on a line beginning `Removes tests:`.

Full text: [SOP 8](sops.md#sop-8-a-conflict-between-two-branches-is-resolved-as-a-union-not-a-choice).

## SOP 9: A web-facing change is driven, not only tested

On a pull request touching `apps/web`, or an `apps/api` response shape a person
would notice, drive the built app with the `run` skill or open its preview, and
look. Put what you observed in the pull request body: what you looked at and
what you saw. "Looks fine" is not a report.

Full text: [SOP 9](sops.md#sop-9-a-web-facing-change-is-driven-not-only-tested).

## SOP 10: A permission gate is not an execution sandbox

Permission files and the classifier decide whether a command runs, not what it
can reach. Both review jobs in `.github/workflows/claude-code-review.yml` run
sandboxed, with `failIfUnavailable: true`; never delete those steps. Local
sessions are unsandboxed. Evidence for a sandbox change is the real CI log
line, not a unit test. Voided by a second person with write access, real data,
or a laptop session running fetched third-party content. A pull request that
removes the sandbox steps gets no automated review.

Full text: [SOP 10](sops.md#sop-10-a-permission-gate-is-not-an-execution-sandbox).
