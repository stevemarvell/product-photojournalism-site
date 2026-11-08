# The API starter (`python-fastapi`)

A FastAPI shell: `/health` (with the deployed commit, once deployed), security
headers, and Swagger UI, ReDoc and `/openapi.json` in development only. No
application logic and no data. `smoke.sh` is its post-deploy checks. Its entry
in `project.json` is `api`.

The AI layer's rules — the loop, `verify`, pull requests, ceilings, issues —
are in the root `CLAUDE.md` and hold here too.

## Rules

- **Not deployed by default.** `npm run verify` is what keeps it green; there
  is no Vercel project building it until
  `npm run deploy:add -- vercel --app api ...` adds one. Once it is deployed,
  merging to `develop` publishes it.

- **It serves no data.** Read `docs/data-governance.md` and rewrite it before
  adding anything that serves, stores, or exposes data.

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
| `IDENTITY_PROVIDER` | `none` (signs nobody in), `stub` (owner; only with `API_ENVIRONMENT=development`, refused when `VERCEL_ENV` is set), `vercel` (Sign in with Vercel; the default when `VERCEL_ENV` is set, else `none`) |
| `VERCEL_OAUTH_CLIENT_ID`, `VERCEL_OAUTH_CLIENT_SECRET`, `OWNER_VERCEL_ID`, `SESSION_SECRET` (32+ chars) | all four needed by `vercel`; with any missing the API still starts, `/auth/*` answers 503 "sign-in not configured" and owner routes 401 |
| `PUBLIC_WEB_ORIGIN` | the origin visitors use; the OAuth redirect URI is `<it>/api/auth/callback` (default: the deployed web app when `VERCEL_ENV` is set, else `http://localhost:5173`) |
| `CORS_ALLOWED_ORIGINS` | comma-separated; `http://localhost:5173,http://127.0.0.1:5173`; never `*` |

## Auth

Every route that is not public (`api.guard.PUBLIC_*`: `/health`, `/version`,
`/auth/*`, `/public/*`) must depend on `api.guard.require_owner`;
`tests/test_owner_guard.py` enumerates the app's routes and fails on one that
answers a no-session request with anything but 401. The session is a signed
cookie (HttpOnly, Secure when served over https, SameSite=Lax). The web app
reaches the API as `/api/*` on its own origin (rewrite in `apps/web/vercel.json`),
so the cookie is first-party. Locally, `npm run dev` in `apps/web` proxies `/api`
to `:8000`; `IDENTITY_PROVIDER=stub` signs in as the owner.

Once deployed, read the `deployment` skill under `apps/api/.claude/skills/`
(written by `deploy:add`) before changing anything that deploys.
