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

The public site is `PublicSite.tsx`: the home page (live pieces, newest first as the API
orders them), `/<uuid>` for one piece, and a not-found page, each a plain white page outside Ionic's
chrome. It fetches `/api/public/pieces` (`public-api.ts`, `cache: no-store`; `VITE_API_URL` is
build-time as before, `/api` deployed, a production build without it shows an error and fetches
nothing). **The word "story" must appear in no visible text, URL or metadata** of it, and
the API paths are `pieces` for that reason (`e2e/public.spec.ts` checks it). `render.ts` is the
renderer: it parses only paragraphs, bold, italic and `<Photo />` and never evaluates MDX or builds
HTML (`docs/data-governance.md`); do not add `dangerouslySetInnerHTML`. Where the API answers 501
(Postgres stories not built, until #34) the home says "No application here yet.", which is also the
string `smoke.sh` looks for in the bundle. `/editor` is owner-only: it asks `/api/auth/me` and sends a
signed-out visitor to `/api/auth/login`, rendering nothing of the editor meanwhile. Run the API
alongside it for local use (`IDENTITY_PROVIDER=stub`); the e2e suite mocks the API with `page.route`.

`/editor` is the owner's story list and `/editor/:id` the drafting screen
(`StoryEditor.tsx`): title, description, date and location fields plus
`BodyEditor.tsx`, MDXEditor (pinned exact, lazy-loaded) with only bold, italic,
a Photo button and a source toggle. The heading, list, quote and link plugins
are deliberately not loaded, and `content.ts` `flattenMarkdown` strips their
markdown (as an mdast pass) from source view and from every save, and `canonicalPhotos` writes Photo attributes with `&`, `"`, `<`, `>` as entities. The browser is only a convenience: the API's `content_problems` is the real restriction. Photo blocks (`PhotoBlock.tsx`)
are edited in place; moves swap the tags in the markdown (`movePhoto`).
The Photo button opens a multi-file picker (`BodyEditor.tsx`, `images-api.ts`): each file asks `/images/upload-target`, is PUT there with a progress row (a file over the limit is refused with the limit shown, before any byte is sent), and is registered; the blocks go in strictly in selection order. `useImageStatuses.ts` polls `GET /images/:id` for every image the draft names; Photo blocks show processing or a failed-image error, and `Preview.tsx` (the draft preview: `render.ts`'s `parseBody` plus the shared `Prose.tsx` paragraph, so it matches the public page) is greyed out until every image is ready. `useAutosave.ts` is the debounced save (409 stops it). Publish is disabled
client-side for what the browser can know (`publishBlockers`) and shows the
API's 422 reasons for the rest (image readiness). `vercel.json` must keep
`/editor/:path*` and `/:id(<hex and dashes>)` (the public `/<uuid>` pages) serving `index.html`, beside the `/api` rewrite.

Once deployed, read the `deployment` skill under `.claude/skills/` here
(written by `deploy:add`) before changing anything that deploys.
