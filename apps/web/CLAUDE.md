# The web starter (`node-react`)

An Ionic React shell on Vite, calling no API. It also builds the project
documentation to `/docs/` inside its own bundle (`scripts/` is its
`prebuild`). `smoke.sh` is its post-deploy checks. Its entry in `project.json`
is `web`.

The AI layer's rules — the loop, `verify`, pull requests, ceilings, issues —
are in the root `CLAUDE.md` and hold here too.

## Rules

- **Not deployed by default.** `npm run verify` is what keeps it green; there
  is no Vercel project building it until
  `npm run deploy:add -- vercel --app web ...` adds one. Once it is deployed,
  merging to `develop` publishes it.

- **It serves no data.** Read `docs/data-governance.md` and rewrite it before
  adding anything that serves, stores, or exposes data.

- **The e2e suite runs against the built bundle** via `vite preview`, never
  the dev server: a unit test runs in-process and structurally cannot see a
  configuration failure that only shows up in a built, served bundle.

## Documentation

The build puts the project documentation at `/docs/`. It reads `docs/`, the
root `index.html` and `scripts/markdown.mjs`, none of which live in this
directory. A page whose source is absent is skipped, not stubbed: a product
carries `docs/sops.md`, `docs/data-governance.md` and `scripts/markdown.mjs`
and has no `docs/adoption.md` or `index.html`, so it has no page for them.
Adding a page touches five files and missing one means a
page that builds locally and 404s wherever it is live — **read the
`docs-site` skill** in `.claude/skills/` here.

## Running it

```bash
npm install && npm run dev      # on http://localhost:5173
node scripts/verify-apps.mjs web   # typecheck, eslint, vitest, build, e2e
```

The home page fetches `/health` from the API at `VITE_API_URL` (build-time; the
deployed value is `/api`, the web origin, which `vercel.json` rewrites to the API
so the session cookie is first-party; `/api` is also the default under
`npm run dev`, proxied to `http://localhost:8000` by `vite.config.ts`; a
production build without it shows "API address not configured." and fetches nothing)
and shows the database status, or a plain
error if the API is unreachable. `/editor` is the owner-only editor: it asks `/api/auth/me` and sends a signed-out visitor to `/api/auth/login`, rendering nothing of the editor meanwhile. Run the API alongside it for local use; the
e2e suite mocks the API with `page.route`.

Once deployed, read the `deployment` skill under `.claude/skills/` here
(written by `deploy:add`) before changing anything that deploys.
