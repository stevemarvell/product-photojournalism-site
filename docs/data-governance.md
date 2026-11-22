# Data governance

What this product stores, where, who can read it, and what would change that.
Read it before changing what is stored, served or exposed, and update it in the
same pull request.

## What is stored

| Data | Holds | Who can read it |
| --- | --- | --- |
| **Stories** | Per story, a **draft** (title, description, location, date, markdown content) and **published** text (the same fields, copied from the draft at publish), plus whether it is live and its publish and edit times. The content can name images by id (`<Photo image="…" alt="…" />`) but holds no image data. | **Drafts: the owner only**, through the owner endpoints. **Published text: public by design**, served anonymously by `GET /public/pieces` and `GET /public/pieces/{id}` and drawn by the public site, and only while the story is live. |
| **Images** | Per image: an id, its status (processing, ready or failed), the **original** (the file as the owner uploaded it, still carrying its GPS and other EXIF; only JPEG, PNG, WebP and TIFF are processed, and any other format ends `failed`), the **web versions** (JPEGs at 480, 960, 1600 and 2400 px wide where the original is at least that wide, never enlarged), and the width, height and byte size. | **Web versions: public by design**, served by key at `/public/images/<image id>-<width>.jpg` as soon as the image is ready, whether or not any story using it is published (the image id is a random UUID, so the URL is unguessable but not secret), with **all EXIF, GPS, ICC and comment data removed** (they are re-encoded from the decoded pixels). **Originals: nobody but the API's own processing code.** The one response that contains an original's URL is the owner-only `POST /images/upload-target`, which hands the owner the address their own browser uploads to; no other response, owner or public, contains it, and the owner's `GET /images/{id}` returns the status and web versions only. |
| **Sessions** | A server-side record per sign-in: a random session id, the owner's user id and the session epoch. No secret, no password, no personal data beyond the id. | Nobody; it is only checked, never served. |
| **The session cookie** | The signed cookie carries the session id, its epoch and the owner's Vercel id (to compare with `OWNER_VERCEL_ID`), or, mid-sign-in, an encrypted single-use PKCE record. | The visitor's own browser. |

Nothing else about visitors is stored. No passwords are handled; the owner signs in
with Vercel.

**Images: Vercel Blob and Postgres in production, the local disk otherwise.** In
production (`VERCEL_ENV=production` with `BLOB_READ_WRITE_TOKEN` set) one **public** Blob
store holds everything, the image rows, the upload targets and their claims are in
Postgres, and the originals are processed inside the `POST /images` request (a serverless
thread may be frozen after the response). The browser uploads an original **straight to
Blob** with a client token the API signs: valid for one hour, for one pathname
(`originals/<24 random bytes>`), capped at `IMAGE_MAX_BYTES`, never overwriting; the API
receives only the stored URL, reads its size by HEAD and its bytes by download, and accepts
only URLs on the store's own host under `originals/` that it issued to the caller's
organisation (kept in Postgres, so that and the single-use claim survive a restart). The
read-write token never leaves the API and is in no response or log. Web versions are written
to `web/<image id>-<width>.jpg` in the same store and served from Blob's own URLs; the API's
`/public/images/` route exists only on the local store. A **preview** holds
preview credentials only: it reads `PREVIEW_DATABASE_URL` and `PREVIEW_BLOB_READ_WRITE_TOKEN`
(a separate Neon database and a separate Blob store) and never `DATABASE_URL`, `POSTGRES_URL`
or `BLOB_READ_WRITE_TOKEN`, so a branch's code cannot reach production's rows or images even
when those variables are present. Without the `PREVIEW_*` variables it keeps in-memory rows and
no upload target (503). Locally the file goes to the owner-only
`PUT /images/uploads/{token}`, which exists **only** when
`API_ENVIRONMENT=development` (or `IMAGE_UPLOADS=local`) and **never** where `VERCEL_ENV` is
set: asking for it there stops the app starting. Originals are **public Blob objects at
unguessable URLs** (owner answer, 2026-11-08; Blob serves them to anyone who has the URL), so
**the original URL itself is the only protection, and must stay out of every response**
(`apps/api/tests/test_blob_images.py` sweeps the public and owner answers for it). An
upload that is never registered stays in the store; nothing sweeps it yet. On the Hobby plan
Blob includes 1 GB, and at the limit it stops for 30 days rather than billing.

The largest accepted file (`IMAGE_MAX_BYTES`, 25 MB) is checked when the target is asked
for, again as the bytes arrive, and again at registration from the stored size. An image
still processing after `IMAGE_PROCESSING_TIMEOUT_SECONDS` (120) is marked failed when next
read.

Writing a story as a draft does not publish it: the public sees only what the owner
chose to publish, and editing a live story changes the draft only until Publish.
Every query is scoped to an organisation id, taken from the signed-in user, so one
organisation's code path cannot read another's stories (today there is one
organisation, the owner's).

## What is public

The public site (`/` and `/<id>`, issue #16) is readable with no login. Exactly this leaves the
API for an anonymous reader, and nothing else of a story does:

- **Per live story, its published title, description, location, date and content, its first
  published date, and each Photo's web versions** (URLs, widths, alt text, caption, credit). A
  story that is not live, never published, or another organisation's answers 404, the same
  for all three. **No draft field is ever read** (`apps/api/src/api/application/public.py`
  touches `published_*` only), and **no original's URL**: a resolved photo
  (`PublicPhoto`) has no field that could hold one.
- **Which organisation:** an anonymous read has no signed-in user to take it from, so it uses
  the one the MVP has, `MVP_ORGANISATION_ID` (`api.domain.models`, the same value the owner's
  `organisation_id` is built from). Every story and image read is filtered by it.
- **The wording rule** (spec section 8): the word "story" is in no visible text, URL or
  document metadata of the public site. The API paths the browser calls are
  `/api/public/pieces`, not `stories`, so no URL it requests carries the word either. Checked
  by `apps/web/e2e/public.spec.ts` (text, URL, title, metadata, attributes and every request
  made) and `apps/api/tests/test_public_site.py` (public JSON).
- **Freshness:** every `/public/pieces` response, success or error, is
  `Cache-Control: no-store` (`NoStorePublic`), and the browser asks with `cache: no-store`. The
  API reads the public list from the database at most once per `PUBLIC_LIST_TTL_SECONDS` per
  server process (5 s by default, at most 60; 0 turns it off) and answers from memory in
  between, successes only, so Publish, Unpublish and Republish show on the list within
  `PUBLIC_LIST_TTL_SECONDS` (5 s by default, at most 60); a single piece
  page is read on every request. Nothing else public is cached except the web versions of
  images (immutable, by id). Caching the pages with invalidation on publish (spec
  section 8) is a later optimisation, not built.
- **Unreachable storage** (the Postgres connection fails, or its migration does) answers
  503 on the public reads too, not an empty page and not a stack trace.

**The renderer rule is a control, and it is enforced and tested.** A published body is MDX
text, but the public renderer (`apps/web/src/render.ts`, drawn by `PublicSite.tsx`) never
evaluates it: it parses only paragraphs, bold, italic and well-formed
`<Photo image alt caption credit />` tags into plain data, which React prints as text nodes.
Everything else (`import a from "x"`, `export const a = 1`, `{expressions}`, `<script>`,
unknown tags, a malformed Photo tag, `&lt;script&gt;`) comes out as the characters it is. There
is no `dangerouslySetInnerHTML` and no MDX runtime in the public bundle.
`apps/web/src/render.test.ts`, `PublicSite.test.tsx` and the hostile-content test in
`e2e/public.spec.ts` (against the built bundle) hold it. `content_problems` refuses most such
text on save, but `import`/`export` lines are stored as prose, so this renderer rule is what
holds.

## Where it is stored

- **Production: Postgres.** Production selects the Postgres adapter by default
  (`STORY_REPOSITORY`), for stories and for sessions (`PostgresStoryRepository`,
  `PostgresSessionStore`, tables `story`, `session`, `session_epoch`; every story query
  filters on `organisation_id`). Local runs use the in-memory adapters
  (`InMemoryStoryRepository`, `InMemorySessionStore`), which lose everything on restart, and
  so does a preview without `PREVIEW_DATABASE_URL`. A preview with it uses that separate
  preview database, migrated the same way as production's. Every web branch alias (`develop`, which is staging for UAT, and pull request previews)
  calls the API's `develop` alias (the web `vercel.json` rewrite); every other host,
  per-deployment hash URLs of previews included, calls the production API, so a preview is
  tested on its branch alias. Production is `main`. The `develop` API is the preview API
  holding the preview credentials, shared by staging and every pull request preview.
- **Migrations** (yoyo-migrations, SQL files in `apps/api/src/api/migrations/`) run inside
  the API process, once per process, before its first query (not at import, so an
  unreachable database still lets `/health` answer 503). They run under a Postgres advisory
  lock, so concurrent cold starts do not race, and are idempotent. If one fails, nothing is
  queried: owner and public routes answer 503, the failure is logged by exception type only
  (never the connection string), and the next request tries again.
- **Sessions are shared across serverless instances.** Sign-out deletes the row and
  revoke-all bumps the user's epoch and deletes their rows in one transaction, so every
  instance refuses the old cookie on its next request. An instance that cannot reach the
  database fails closed (503 / no session). Rotating `SESSION_SECRET` remains the remedy if
  the secret leaks.
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
  stored epoch (`api.guard.current_user`). **Signing out deletes the record** (in
  production, the row in the shared database), so a copy of the cookie is refused on
  every instance. **`POST /auth/revoke-all`** bumps the
  epoch: every session, the caller's included, is refused on its next request.
  Rotating `SESSION_SECRET` still invalidates everything, and is the remedy if the
  secret itself leaks.

- **The web app's security headers** (`apps/web/vercel.json` `headers`, from the one
  constant in `apps/web/security-headers.mjs`) are on every page except `/api/*`, which
  keeps the API's own: a `Content-Security-Policy` that loads scripts only from the site
  itself (`script-src 'self'`; styles also inline because Ionic injects them; images and
  connections also to Vercel Blob's `*.public.blob.vercel-storage.com`, and to `https://vercel.com/api/blob/` (where the browser PUTs an original); fonts same-origin
  or `data:`), `frame-ancestors 'none'` with `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy` denying
  camera, microphone and geolocation. A test asserts `vercel.json` and the constant agree,
  and `apps/web/e2e/csp.spec.ts` asserts no policy violation on the home page, a piece
  page and the editor. Widening the policy (a new host, `'unsafe-inline'` for scripts)
  voids this control.

- **The image rules**: the local upload endpoint is mounted only in development and never
  with `VERCEL_ENV` set (`apps/api/tests/test_local_uploads.py`); it and every other owner
  image route are probed by the owner-guard audit; the public image route serves only
  web-version keys (`apps/api/tests/test_images.py`) and is not mounted at all on Blob; web versions are rebuilt from pixels
  with no metadata (the same file, with a GPS-bearing fixture).

**What voids this verdict:** the session store being absent or bypassed (a route that
reads the cookie without `current_user`), a public route that returns draft text, a
second person given owner access, or the public renderer (`apps/web/src/render.ts`) doing anything but
parsing only the subset `content_problems` allows: it must never evaluate MDX or build HTML from a body, and
`content_problems` must keep running on save and on publish. Images, Blob and the Postgres image adapter are covered above; before the Postgres story adapter ships, revisit this page. A second Blob store, a private one, or processing moved out of the request would change the image paragraph above: revisit it then.

## What CI holds, and what voids that

Releases: a push to `main` (production) or `develop` (staging) starts `smoke`, which reads no secret and only requests the deployed URLs. What reaches `main` is gated by the owner's `go` on the release or hotfix pull request (`docs/releases.md`); that gate is discipline, bounded by the merge naming the approved head sha, and nothing mechanical blocks a direct push to `main`.

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

The `pr checks` job in `.github/workflows/pr-checks.yml` (it replaces the old
`contention` and `test census` workflows) holds no secret in the table but
carries `GITHUB_TOKEN` scoped `pull-requests: write`. GitHub has no
comment-only permission, so that scope also permits merging, closing and
labelling any open pull request. So no script from the pull request's checkout
runs in it: `scripts/pr-contention.mjs` and `scripts/test-census.mjs` execute
from `base-scripts/`, a second checkout of the base commit (sparse to
`scripts/`), and read the pull request's tree only through `git`. A pull
request that edits either script is judged by the unedited copy.
`scripts/test/pr-checks-base-scripts.test.ts` allowlists what each step may
run. Every checkout in every workflow sets `persist-credentials: false`
(`scripts/test/checkout-credentials.test.ts`). The workflow file itself is
still read from the pull request's ref, so a pull request that edits it runs
its own steps with the token: the one-writer bound holds and a second writer
voids it.

The code and security reviews run once, when a pull request is opened or marked
ready, and again only when the `re-review` label is added. They do not re-run on
a push, and they are advisory. That holds while one person with write access
drives merges and adds `re-review` as `drive-pr` step 4 says; a second writer
voids it.
