# product-photojournalism-site

A photojournalism site. One owner writes picture stories (text with Photo
blocks), keeps a draft separate from what is published, and publishes; the
public site shows only the published text of live stories. The build spec is
the *Photojournalism Site MVP: Build Spec v2* doc
(https://claude.ai/code/artifact/7fbdc774-5dba-4a7a-a785-5f2f597c27fe); its
build order is the issue chain #11 to #17.

Branches: `main` is production, `develop` is the develop preview, where the owner does UAT, and a feature branch is
its pull request's preview. Free Vercel addresses:

- web (production, from `main`): https://photojournalism-site-stevemarvell-team.vercel.app
  (the API is reached through its `/api` rewrite, so the sign-in cookie is first-party)
- API (production, from `main`): https://photojournalism-site-api-stevemarvell-team.vercel.app,
  with a Neon Postgres database in production
- the `develop` preview (a Preview deployment): web
  https://photojournalism-site-git-develop-stevemarvell-team.vercel.app and API
  https://photojournalism-site-api-git-develop-stevemarvell-team.vercel.app. Every web branch
  alias (`develop` and pull request previews) calls the API's `develop` alias, which uses the
  preview Neon database and Blob store (`PREVIEW_*`); every other host, preview hash URLs
  included, calls the production API, so test a preview on its branch alias. A preview API
  without `PREVIEW_*` runs on memory with uploads off

Promoting to production: once the owner has done UAT on the develop preview, open a pull request
`develop` into `main` and merge it with a merge commit (not a squash, so `main` and
`develop` keep a shared history). Vercel then builds `main` to production. Nothing else
merges to `main`.

The AI layer — `.claude/`, `scripts/`, `.github/`, `telemetry/` — is the
engine: the loop of verify, review, isolate, deploy, smoke and triage.
It learns about the apps only from `project.json`. Each app's own rules, layout and run
commands are in the `CLAUDE.md` inside its directory; read it before working
there.

## Layout

| Path | Holds |
| --- | --- |
| `apps/api/` | The FastAPI back end in hexagonal layers (`domain/`, `application/` ports, `adapters/`), run as Vercel Python functions: `/health`, `/version`, Sign in with Vercel under `/auth/*`, and the owner guard every non-public route uses. Its own rules are in `apps/api/CLAUDE.md`. |
| `apps/web/` | The Ionic React front end on Vite: the public site, sign-in, and the owner-only `/editor`, with a Playwright end-to-end suite and the documentation site built into its bundle at /docs/. Its own rules are in `apps/web/CLAUDE.md`. |
| `project.json` | The one place the AI layer learns about the apps: paths, toolchains, build inputs, and each app's Vercel deployment. Read through `scripts/project.mjs`. |
| `docs/` | `sops.md`, how agent work is run; `releases.md`, the branching strategy and how `develop` is released to `main`; `data-governance.md`, what the deployment holds and exposes, and the sign-in controls everything else relies on. |

<!-- shared:begin — the AI layer's rules, identical in every repository built
from boris. Edit them in boris and sync; a local edit here is lost on the next
sync. Repository-specific facts go in the sections outside this block. -->

## Rules

- **`npm run verify` is the contract.** It runs the AI layer's own tests, then
  every app's own `verify` commands from `project.json`. Never report work as
  done until it passes — run it yourself rather than asking someone else to. A
  `Stop` hook runs it automatically when tracked files have changed, so a red
  loop blocks the turn rather than producing a claim.

- **Every behaviour change ships with a test.** A bug fix means a test that
  fails before the fix. A new feature means the happy path and the error path.
  A change that ends up with *fewer* tests than its base says so in the pull
  request body, in a line beginning `Removes tests:` — the `pr checks` job
  counts both sides and goes red without one.

- **Code is written by `implementer` agents.** The coordinating session — the
  one talking to the person — triages, briefs, checks work on its preview,
  replies to reviews and merges. It does not write application or AI-layer
  code itself, including fixes for review findings: those go back to an
  implementer (`drive-pr` step 3), and new work is handed over the same way
  (`work-backlog` step 2). The coordinator edits only docs, logs and issue
  text. **Read the `delegate` skill** before any agent work.

- **Every change ships as a pull request, and the coordinator merges it.**
  Branch off `develop`, push the branch, open a PR against `develop` (the
  GitHub MCP tools; `gh pr create` is GraphQL, which cloud sessions refuse),
  and merge once `verify` is green — without
  asking; a green PR left open is work that looks finished and is not. Never
  commit or push directly to `develop`. Whether anything mechanical enforces
  these is a repository setting, recorded under *Repository settings* below,
  not assumed. A product that publishes production from `main` releases by
  `docs/releases.md` and the `release` skill.

- **Decide and act; report after.** The test is **recoverability, not scope**:
  stop for work nobody can get back, for money, and for anything reaching a
  third party. Everything else is decided, done, and recorded in the pull
  request body where the reviewers read it. Recoverable is established by a
  command, not by eye. `docs/sops.md` SOP 6.
  Stopping for one of these three means opening a human issue (SOP 2) and
  stopping that thread; no turn ends with a question or an offer of further work.

- **`docs/adoption.md` preserves the source wording.** It is a rendering of the
  original document, not a rewrite. Restructure the layout freely, but do not
  reword, summarise, or drop content, and keep every link intact.

- **Config and operating knowledge live in the repo.** A setting only visible
  in a web console, or a rule that lives in one machine's memory, is missing
  for everyone else and from every fresh clone.

- **No paid tiers.** Anything a paid plan gates — GitHub Pro rulesets, Claude
  Team or Enterprise features, Vercel Pro — is permanently unavailable, not
  pending. An issue that needs one is labelled `blocked: no paid plan`.

- **Issues are user stories.** Every issue, filed by a person or an agent,
  uses the sections of `.github/ISSUE_TEMPLATE/story.md` (GitHub's
  "New issue" button offers it): persona, story,
  Given/When/Then acceptance criteria (unhappy paths included), details to
  complete, tech notes, testing notes, references, then its `Depends on #<n>`
  lines. Each **Then** states what is true afterwards, in positive terms with
  an observable result ("the API answers 401"), never what stops being true;
  an unhappy path is stated as the outcome that happens instead. **Details to
  complete** holds what the assignee needs so nothing is looked up or guessed
  (for a `human` issue, its instructions; "None" if nothing is needed). The issue
  labelled `template` is the blank copy: nobody fills that one in, and triage
  never picks it.

- **Diagrams in Markdown are Mermaid blocks**, never ASCII art.

- **Every loop declares a maximum, and reports when it hits it.** No skill,
  command, or agent retries until it succeeds — an unbounded loop has no upper
  bound on cost, and subagents do get killed mid-task by session limits.
  Reaching the ceiling means stop and say what failed; it is the procedure
  working, not a failure to hide. The declared ceilings, and which are
  mechanically enforced and which are only discipline, are in `docs/sops.md`.

- **Work that needs a person is labelled, not attempted.** A dashboard behind
  a login, a credential, a subjective judgement, a purchase: label the issue
  `human` *and* `do not automate`, and assign it. An agent that meets one
  mid-task stops there and reports what remains. `docs/sops.md` SOP 2.

- **Context is the budget.** Every request carries the whole conversation, so
  cost tracks context size rather than effort. Clear between unrelated tasks,
  keep this file under 200 lines with specialised knowledge in skills, and
  filter verbose output in a hook rather than reading it. `docs/sops.md` SOP 4
  has the order of operations; model choice is the smallest lever, not the
  first.

- **Known gaps live in GitHub issues, not in a file.** A backlog file goes
  stale, because nothing connects a merge to a line in it. Close an item the
  way the work closes it — a `Closes #<n>` line in a pull request body. Write
  that example with a placeholder, never a real number: spelling one out to
  illustrate the rule closes that issue on merge. Where the issue's done-when
  is confirmation *outside* the repository, `Closes` belongs on the pull
  request that confirms, not the one that fixes — merging a fix is not
  evidence it worked. Labels carry the structure: `aia0`/`aia1`/`aia2` for
  the adoption step, `security` for exposure, and one of
  `critical`/`high`/`medium` for how bad it is and therefore when it gets
  done.

- **One scale ranks everything.** `critical`/`high`/`medium` carries both how
  bad a thing is and when it gets done. There is no second severity axis: two
  rankings drift apart, and the one in the label wins by default. The same goes
  for any fact written in two places. Anything below `critical` is a claim that
  something bounds it — the issue says what, and what would void it.
  `docs/sops.md` SOP 5.

## Running it

**Editing dependencies needs npm 11.** npm 10 cannot resolve `vitest` 4's
optional peer set: its arborist crashes with *"Cannot read properties of
null (reading 'edgesOut')"* on `npm install`, `npm install --workspace` and
`npm ci`. The lockfile is version 3 and `npm ci` reads it fine under npm 10
(what CI runs); to change a dependency, lock with `npx npm@11 install`.

```bash
npm run verify                     # everything, about a minute
npm run verify:harness             # the AI layer's own tests, scripts/test
npm run verify:apps                # every app's own checks, from project.json
node scripts/verify-apps.mjs web   # one app's: typecheck, eslint, vitest, build, e2e
```

CI runs `verify` on every pull request and by hand (`workflow_dispatch`); it is
the one check the coordinator waits for before merging. It does **not** run on
a push to `develop`: nothing mechanical verifies a direct push, so "never push
to `develop`" is discipline alone (SOP 1, "What CI runs, and when"). A `smoke` workflow runs
after each merge: for each deployed app in `project.json`, it waits for the
deployment to be this commit, then runs that app's own checks
(`scripts/smoke.mjs`). Claude Code Review comments once per pull request, when it is opened or marked
ready, and again only when the `re-review` label is added; it does not re-run
on a push, and it is advisory. When the driver adds `re-review` is defined in
`drive-pr` step 4.
Merging on a local `verify` is allowed only when CI did not run (`drive-pr` step 1).

## Agents and skills

| To | Use |
| --- | --- |
| Pick what to work next | `node scripts/triage.mjs`, or the `work-backlog` skill to work it |
| Hand code or a review to an agent in `.claude/agents/` | **the `delegate` skill** — the brief, the ceiling, what comes back |
| Take a pull request to merged | the `drive-pr` skill |
| Isolate, and later clean up, an agent's checkout | the `worktrees` skill |
| Verify, commit and open a PR | `/ship`; just verify: `/gate` |
| Release `develop` to production, hotfix, roll back | the `release` skill; `docs/releases.md` |
| Sync this block and `.claude/` with boris or a repository built from it | the `sync-ai-layer` skill |

<!-- shared:end -->
