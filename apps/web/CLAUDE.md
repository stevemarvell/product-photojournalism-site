# The web app (`apps/web`)

The Ionic React front end on Vite: the public site, sign-in, and the
owner-only `/editor`. It calls the API at `/api`, which `vercel.json`
rewrites to the API deployment, so the session cookie is first-party. It also
builds the project documentation to `/docs/` inside its own bundle
(`scripts/` is its `prebuild`). `smoke.sh` is its post-deploy checks. Its
entry in `project.json` is `web`.

The AI layer's rules — the loop, `verify`, pull requests, ceilings, issues —
are in the root `CLAUDE.md` and hold here too.

## Rules

- **Merging to `develop` publishes it.** The Vercel project builds every
  push to `develop` to production; the `deployment` skill in
  `apps/web/.claude/skills/` has the settings.

- **Read `docs/data-governance.md` before changing what is stored, served or
  exposed,** and update it in the same pull request.

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
error if the API is unreachable. `/editor` is the owner-only editor: it asks `/api/auth/me` and sends a signed-out visitor to `/api/auth/login`, rendering nothing of the editor meanwhile. Run the API alongside it for local use (`IDENTITY_PROVIDER=stub`); the
e2e suite mocks the API with `page.route`.

`/editor` is the owner's story list and `/editor/:id` the drafting screen
(`StoryEditor.tsx`): title, description, date and location fields plus
`BodyEditor.tsx`, MDXEditor (pinned exact, lazy-loaded) with only bold, italic,
a Photo button and a source toggle. The heading, list, quote and link plugins
are deliberately not loaded, and `content.ts` `flattenMarkdown` strips their
markdown from source view and from every save. Photo blocks (`PhotoBlock.tsx`)
are edited in place; moves swap the tags in the markdown (`movePhoto`).
`useAutosave.ts` is the debounced save (409 stops it). Publish is disabled
client-side for what the browser can know (`publishBlockers`) and shows the
API's 422 reasons for the rest (image readiness). `vercel.json` must keep
`/editor/:path*` serving `index.html`, beside the `/api` rewrite.

Once deployed, read the `deployment` skill under `.claude/skills/` here
(written by `deploy:add`) before changing anything that deploys.
