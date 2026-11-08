# Data governance

A stub. The API connects to a Postgres database in production but stores no
stories or images yet; it processes a session cookie (signed, HttpOnly, no
password) and the owner's Vercel id, used only to sign the owner in. No
passwords are handled.

The API (`apps/api`) connects to a Neon Postgres database in production
(`VERCEL_ENV=production`). It stores nothing in it yet. Previews use the
in-memory adapter by default and reach the database only if `STORY_REPOSITORY`
is set explicitly. `/health` exposes only the adapter name and whether it is
reachable, never the connection string.

Rewrite this page before anything that serves, stores or exposes data ships:
what is exposed, to whom, why that is deliberate, and what would change it.

## What CI holds, and what voids that

The engine ships workflows that read repository secrets. A new product has
none set; the owner sets each with `gh secret set`, and until then the
workflows that read it have nothing to read.

| Secret | Read by |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | `.github/workflows/claude-code-review.yml`, `claude.yml` |
| `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_OTLP_AUTH` | the same two workflows |
| `VERCEL_TOKEN` | `.github/workflows/preview-prune.yml` (expiry: `README.md`, Secrets) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `.github/workflows/telegram-notify.yml` |

The review jobs check out a pull request and run a script from that checkout
while a credential is live, so a pull request can run its own code with it.
Two things bound that: the trigger is `pull_request`, not
`pull_request_target`, so a fork gets no secrets; and one person has write
access, so that code is the owner's own, run with the owner's own credential.
The second holds only while it is true: it is a fact about membership, not
something in the configuration.

**The trigger that voids it: a second person gets write access once any of
these secrets is set.** Before that, move branch-code steps out of the
credentialed jobs or pass the secrets only to the action's own step, and
rewrite this section.
