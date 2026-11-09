# The API (`apps/api`)

The FastAPI back end, in hexagonal layers: `domain/` (no framework imports),
`application/` (use cases and ports), `adapters/` (in-memory, Postgres,
filesystem, the identity providers, and the FastAPI routes).
`composition.py` picks the adapters from environment variables. It serves
`/health` (with the database's reachability), `/version` (the deployed
commit, which smoke's freshness gate reads), and Sign in with Vercel under
`/auth/*`. Swagger UI, ReDoc and `/openapi.json` are development only.
`smoke.sh` is its post-deploy checks. Its entry in `project.json` is `api`.

The AI layer's rules — the loop, `verify`, pull requests, ceilings, issues —
are in the root `CLAUDE.md` and hold here too.

## Rules

- **Merging to `develop` publishes it.** The Vercel project builds every
  push to `develop` to production; the `deployment` skill in
  `apps/api/.claude/skills/` has the settings.

- **Read `docs/data-governance.md` before changing what is stored, served or
  exposed,** and update it in the same pull request.

## Running it

```bash
cd apps/api && uv sync
API_ENVIRONMENT=development IDENTITY_PROVIDER=stub \
  uv run uvicorn api.main:app --reload                             # on :8000
uv run ruff check . && uv run pytest -q                            # its checks
```

`API_ENVIRONMENT=development` opts back into Swagger UI, ReDoc and
`/openapi.json`, all three off by default.

Hexagonal layers under `src/api/`: `domain/` and `application/` (ports) import
no FastAPI, psycopg or `api.adapters` (a test enforces it); `adapters/` hold the
implementations; `composition.py` picks them from environment variables, and
`/health` adds the database status (503 when unreachable, no connection string; the ping is cached for 10 s).

| Variable | Values (default first) |
| --- | --- |
| `STORY_REPOSITORY` | `memory`, `postgres` (needs `DATABASE_URL`, else `POSTGRES_URL`); default is `postgres` when `VERCEL_ENV` is set |
| `IMAGE_STORE` / `IMAGE_DIR` | `filesystem` / `.data/images` (`/tmp/images` when `VERCEL_ENV` is set) |
| `IMAGE_UPLOADS` | `local` (originals PUT to this API's owner-only `/images/uploads/{token}`) or `off`; default `local` only with `API_ENVIRONMENT=development` and no `VERCEL_ENV`, else `off` (uploads answer 503); `local` with `VERCEL_ENV` set refuses to start |
| `IMAGE_MAX_BYTES`, `IMAGE_PROCESSING_TIMEOUT_SECONDS`, `IMAGE_MAX_PIXELS` | `26214400` (25 MB), `120`, `64000000` (an original declaring more pixels fails before it is decoded) |
| `IDENTITY_PROVIDER` | `none` (signs nobody in), `stub` (owner; only with `API_ENVIRONMENT=development`, refused when `VERCEL_ENV` is set), `vercel` (Sign in with Vercel; the default when `VERCEL_ENV` is set, else `none`) |
| `VERCEL_OAUTH_CLIENT_ID`, `VERCEL_OAUTH_CLIENT_SECRET`, `OWNER_VERCEL_ID`, `SESSION_SECRET` (32+ chars) | all four needed by `vercel`; with any missing the API still starts, `/auth/*` answers 503 "sign-in not configured" and owner routes 401 |
| `PUBLIC_WEB_ORIGIN` | the origin visitors use; the OAuth redirect URI is `<it>/api/auth/callback` (default: the deployed web app when `VERCEL_ENV` is set, else `http://localhost:5173`) |
| `CORS_ALLOWED_ORIGINS` | comma-separated; `http://localhost:5173,http://127.0.0.1:5173`; never `*` |

## Stories

`/stories` (owner only): create, list, read, `PUT /{id}/draft` (409 when the sent
`updated_at` is stale) and `POST /{id}/publish` (422 with `reasons`), and `POST /{id}/unpublish|republish|revert` (422 with `reasons` when the story's state does not allow it and nothing changes; 409 only when a save landed in between; revert bumps `updated_at`, unpublish and republish do not). `PUT` also refuses (422) a body outside the allowed subset (`domain/content.py`: prose, bold, italic and well-formed `<Photo>` tags only; no other tag, raw HTML, `{expressions}` or `import`/`export`). The rules live in
`domain/story.py`, use cases in `application/stories.py`, and every repository call
takes the signed-in user's `organisation_id`. Storage is in-memory only: the Postgres
story methods raise `NotImplementedError` (the API answers 501) until its follow-up.

## Public site

`GET /public/pieces` and `GET /public/pieces/{id}` (anonymous; the path says `pieces`, not
`stories`, because the public site never carries that word in a URL the browser can see).
`application/public.py` (`PublicSite`) reads only `published_*` of live stories in
`MVP_ORGANISATION_ID` (anonymous reads have no user), orders by first published date, and
resolves each Photo to its web versions; `public_routes.py` shapes it and `NoStorePublic`
makes every answer `Cache-Control: no-store`. `tests/test_public_site.py` is its scenarios,
including a sweep of every public answer for draft text and original URLs.

## Images

The browser asks `POST /images/upload-target {size}` (413 with the limit when too big,
503 when no target is configured), PUTs the file to the returned `upload_url`, then
registers it with `POST /images {original_url}`; the row starts `processing` and
`ImageProcessor` (in-process thread locally, behind a port because where it runs in
production is open) makes the web versions with Pillow, re-encoding from pixels so no
EXIF survives. `GET /images/{id}` (owner) returns status and web versions and **never
`original_url`**; `GET /public/images/{key}` serves web-version keys only. The real
`ImageStatusLookup` is `ImageService.status`; a stuck image is failed when read past the
timeout, by the `Clock` port. Vercel Blob replaces `OriginalUploads` and `ImageStore`
(follow-up). Rules in `domain/image.py`, use cases in `application/images.py`.

## Auth

Every route that is not public (`api.guard.PUBLIC_*`: `/health`, `/version`,
`/auth/*`, `/public/*`) must depend on `api.guard.require_owner`;
`tests/test_owner_guard.py` enumerates the app's routes and fails on one that
answers a no-session request with anything but 401. The session is a signed
cookie (HttpOnly, Secure when served over https, SameSite=Lax) that names a
server-side record in the `SessionStore`: `current_user` checks the record and its
epoch on every request, so `POST /auth/logout` and `POST /auth/revoke-all` (owner
only, listed in `guard.OWNER_ONLY_UNDER_PUBLIC`) revoke a copied cookie. The web app
reaches the API as `/api/*` on its own origin (rewrite in `apps/web/vercel.json`),
so the cookie is first-party. Locally, `npm run dev` in `apps/web` proxies `/api`
to `:8000`; `IDENTITY_PROVIDER=stub` signs in as the owner.

Once deployed, read the `deployment` skill under `apps/api/.claude/skills/`
(written by `deploy:add`) before changing anything that deploys.
