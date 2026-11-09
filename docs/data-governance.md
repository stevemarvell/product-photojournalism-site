# Data governance

What this product stores, where, who can read it, and what would change that.
Read it before changing what is stored, served or exposed, and update it in the
same pull request.

## What is stored

| Data | Holds | Who can read it |
| --- | --- | --- |
| **Stories** | Per story, a **draft** (title, description, location, date, markdown content) and **published** text (the same fields, copied from the draft at publish), plus whether it is live and its publish and edit times. The content can name images by id (`<Photo image="…" alt="…" />`) but holds no image data. | **Drafts: the owner only**, through the owner endpoints. **Published text: public by design**, once the public site exists (#16 and later) and only while the story is live. |
| **Sessions** | A server-side record per sign-in: a random session id, the owner's user id and the session epoch. No secret, no password, no personal data beyond the id. | Nobody; it is only checked, never served. |
| **The session cookie** | The signed cookie carries the session id, its epoch and the owner's Vercel id (to compare with `OWNER_VERCEL_ID`), or, mid-sign-in, an encrypted single-use PKCE record. | The visitor's own browser. |

Nothing else about visitors is stored. No passwords are handled; the owner signs in
with Vercel. Images are not stored yet (#15).

Writing a story as a draft does not publish it: the public sees only what the owner
chose to publish, and editing a live story changes the draft only until Publish.
Every query is scoped to an organisation id, taken from the signed-in user, so one
organisation's code path cannot read another's stories (today there is one
organisation, the owner's).

## Where it is stored

- **Today: in memory only.** Stories and sessions live in the API process's memory
  (`InMemoryStoryRepository`, `InMemorySessionStore`) and are lost when it restarts.
  This is the adapter local runs and previews use.
- **Production: Postgres, once the follow-up lands.** Production selects the Postgres
  adapter by default (`STORY_REPOSITORY`), but its story methods are not built: they
  raise `NotImplementedError`, and the API answers the owner story endpoints with
  501. That is deliberate and safe for now: **nobody can sign in on production yet**
  (sign-in is not configured there), so no story exists to lose or to leak. It must be
  built before the owner is given access. The follow-up needs the stories table and
  migrations, a persistent session store, and the shared repository contract suite
  un-skipped for Postgres.
- **Sessions on a serverless host** held in memory are per instance. Lookups fail
  closed: an instance that has no record for a cookie refuses it, so the owner may be
  signed out after a restart or when another instance answers. **Revocation does not
  fail closed across instances**: sign-out or revoke-all deletes the record only on the
  instance that handled it, and another instance that still holds the record keeps
  honouring the cookie until the record expires (12 hours, the cookie's own lifetime).
  Revocation is reliable on a single instance only, until the persistent session store
  of #34 lands. **Sign-in on production must not be enabled (#27) before #34**, or the
  owner accepts per-instance revocation for up to 12 hours. Rotating `SESSION_SECRET`
  remains the remedy that works across every instance.
- Records expire after the session max age (12 hours), and revoke-all deletes the
  user's records as well as bumping the epoch.

`/health` exposes only the adapter name and whether it is reachable, never the
connection string.

## Sign-in: the controls everything else leans on

Only the owner may reach the editor or any write endpoint. These are the
load-bearing controls, and the verdict below holds only while all of them do:

- **Every non-public route depends on `api.guard.require_owner`**, enforced by
  `apps/api/tests/test_owner_guard.py`, which audits every entry in the app's
  routes (API routes, mounted sub-apps, websockets) and fails on one that is
  neither public nor answering 401 without a session.
- **`/auth/*` and `/public/*` are public prefixes** (`api.guard.PUBLIC_PREFIXES`):
  anything added under them skips the guard. Nothing that writes or reads
  owner-only data may go there. The one owner route under `/auth/`,
  `POST /auth/revoke-all`, is listed in `api.guard.OWNER_ONLY_UNDER_PUBLIC`: it names
  `require_owner` itself and the audit probes it like any other owner route.
- **`OWNER_VERCEL_ID`** (the Vercel `sub` allowed in) and **`SESSION_SECRET`**
  (signs the session cookie; derives the key that seals the pending sign-in).
  With either missing, sign-in is off and owner routes answer 401.
- **The session cookie**: signed, HttpOnly, SameSite=Lax, Secure over https,
  12 hours. Every `/auth/*` response is `Cache-Control: no-store`.
- **Server-side sessions.** Every sign-in creates a record in the `SessionStore`, and
  every owner request must present a cookie whose session id is in the store at the
  stored epoch (`api.guard.current_user`). **Signing out deletes the record**, so a
  copy of the cookie stops working at once on that instance (see the caveat above on
  other instances). **`POST /auth/revoke-all`** bumps the
  epoch: every session, the caller's included, is refused on its next request.
  Rotating `SESSION_SECRET` still invalidates everything, and is the remedy if the
  secret itself leaks.

**What voids this verdict:** the session store being absent or bypassed (a route that
reads the cookie without `current_user`), a public route that returns draft text, or a
second person given owner access. Before the Postgres story adapter ships, revisit
this page; before images are stored, add them here.

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
