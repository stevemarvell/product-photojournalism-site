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
API_ENVIRONMENT=development uv run uvicorn api.main:app --reload   # on :8000
uv run ruff check . && uv run pytest -q                            # its checks
```

`API_ENVIRONMENT=development` opts back into Swagger UI, ReDoc and
`/openapi.json`, all three off by default.

Once deployed, read the `deployment` skill under `apps/api/.claude/skills/`
(written by `deploy:add`) before changing anything that deploys.
