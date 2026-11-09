# Data governance

What this product stores, where, who can read it, and what would change that.
Read it before changing what is stored, served or exposed, and update it in the
same pull request.

## What is stored

| Data | Holds | Who can read it |
| --- | --- | --- |
| **Stories** | Per story, a **draft** (title, description, location, date, markdown content) and **published** text (the same fields, copied from the draft at publish), plus whether it is live and its publish and edit times. The content can name images by id (`<Photo image="…" alt="…" />`) but holds no image data. | **Drafts: the owner only**, through the owner endpoints. **Published text: public by design**, once the public site exists (#16 and later) and only while the story is live. |
| **Images** | Per image: an id, its status (processing, ready or failed), the **original** (the file as the owner uploaded it, still carrying its GPS and other EXIF), the **web versions** (JPEGs at 480, 960, 1600 and 2400 px wide where the original is at least that wide, never enlarged), and the width, height and byte size. | **Web versions: public by design**, served by key at `/public/images/<image id>-<width>.jpg`, with **all EXIF, GPS, ICC and comment data removed** (they are re-encoded from the decoded pixels). **Originals: nobody but the API's own processing code.** No response of any endpoint, owner or public, contains an original's URL; the owner's `GET /images/{id}` returns the status and web versions only. |
| **Sessions** | A server-side record per sign-in: a random session id, the owner's user id and the session epoch. No secret, no password, no personal data beyond the id. | Nobody; it is only checked, never served. |
| **The session cookie** | The signed cookie carries the session id, its epoch and the owner's Vercel id (to compare with `OWNER_VERCEL_ID`), or, mid-sign-in, an encrypted single-use PKCE record. | The visitor's own browser. |

Nothing else about visitors is stored. No passwords are handled; the owner signs in
with Vercel.

**Images are stored locally for now.** Originals and web versions sit on the API
host's disk (`IMAGE_DIR`, `.data/images` by default, `/tmp/images` where `VERCEL_ENV` is
set) and the image rows in memory, both lost with the host. Vercel Blob is not provisioned
(it needs the owner's approval), so **on a deployment there is no upload target: asking for
one answers 503 and nothing can be registered.** The browser's flow is already the Blob
client-upload shape (ask for an upload target, send the file there, register its URL), so
Blob replaces the local adapter without changing it; that is a follow-up. Locally the
file goes to the owner-only `PUT /images/uploads/{token}`, which exists **only** when
`API_ENVIRONMENT=development` (or `IMAGE_UPLOADS=local`) and **never** where `VERCEL_ENV` is
set: asking for it there stops the app starting. Until Blob, "originals stay private" is
true because an original's key (`orig-<random token>`) is not a name the public image route
accepts (it serves only `<uuid>-<width>.jpg`) and no API response repeats it. Once Blob holds
originals, MVP originals sit at unguessable URLs (owner answer, 2026-11-08), so **the
original URL itself is the only protection, and must stay out of every response.**

The largest accepted file (`IMAGE_MAX_BYTES`, 25 MB) is checked when the target is asked
for, again as the bytes arrive, and again at registration from the stored size. An image
still processing after `IMAGE_PROCESSING_TIMEOUT_SECONDS` (120) is marked failed when next
read.

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
- **`content_problems`** (`apps/api/src/api/domain/content.py`) is the only thing that
  restricts what a story body may contain: prose, bold, italic and well-formed
  `<Photo>` tags, with no other tag, raw HTML or `{expression}`: `<` and `{` are refused
  outright. `import`/`export` lines are not checked (they are plain prose; a line check
  refused prose and missed forms), so the other control is the renderer rule below: it
  parses only this subset and never evaluates MDX. The editor's own limits are a convenience and are not a control. It is checked
  on every draft save (`PUT /stories/{id}/draft`) and again on publish, so the text
  that becomes public never rests on the save path alone; `apps/api/tests/test_story_content.py`
  covers both.
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

- **The image rules**: the local upload endpoint is mounted only in development and never
  with `VERCEL_ENV` set (`apps/api/tests/test_local_uploads.py`); it and every other owner
  image route are probed by the owner-guard audit; the public image route serves only
  web-version keys (`apps/api/tests/test_images.py`); web versions are rebuilt from pixels
  with no metadata (the same file, with a GPS-bearing fixture).

**What voids this verdict:** the session store being absent or bypassed (a route that
reads the cookie without `current_user`), a public route that returns draft text, a
second person given owner access, or the public renderer (issue 16) doing anything but
parsing only the subset `content_problems` allows: it must never evaluate MDX, and
`content_problems` must keep running on save and on publish. Before the Postgres story adapter ships, revisit
this page; images are now covered above; before Blob or the Postgres image adapter ships, revisit this page.

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
