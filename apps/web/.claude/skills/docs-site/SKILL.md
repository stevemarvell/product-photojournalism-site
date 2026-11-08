---
name: docs-site
description: How this project's documentation site is built, and what carries it once the web app is deployed — what lives at /docs/, and the files that must change together to add or remove a page. Read before editing docs/, apps/web/scripts/build-docs.mjs, scripts/markdown.mjs, or apps/web/smoke.sh.
---

# The documentation site

Adding one page touches five files. They are listed at the end; missing one
means a page that builds locally and 404s wherever the web app is deployed.

## Documentation

Everything this project publishes about itself builds into the web app's own
bundle, at `/docs/`. It is reachable wherever that app is deployed —
`npm run deploy:add` is what deploys it — and nowhere while it isn't; this
repository's own default is nothing deployed. Nothing here is ever hosted
anywhere a private repository cannot reach.

| URL | Source |
| --- | --- |
| `/docs/` | `apps/web/scripts/build-docs.mjs` |
| `/docs/adoption.html` | `docs/adoption.md` |
| `/docs/data-governance.html` | `docs/data-governance.md` |
| `/docs/sops.html` | `docs/sops.md` |
| `/docs/step-0.html` | `index.html` |

The web app's `prebuild` runs `apps/web/scripts/build-docs.mjs`, which renders the
Markdown with `scripts/markdown.mjs` and writes `apps/web/public/docs/`. That
directory is generated, gitignored, and deleted on every run — edit the
sources, never the output.

## Adding or removing a page, the full list

`apps/web/smoke.sh` is not on it: it asks `build-docs.mjs --list` which pages
the build publishes from the sources a repository holds, and checks each is
served with its own heading, so it follows the build.

1. `apps/web/scripts/build-docs.mjs` — the `MARKDOWN_PAGES` entry
2. `apps/web/src/build-docs.test.ts` — the stand-in repository and its assertions
3. `apps/web/e2e/docs.spec.ts` — the `MARKDOWN` table of page and source; the
   index and render tests are generated from it for whichever sources exist
4. `CLAUDE.md` — the Layout row, if the source file is new
5. the Markdown source itself

This skill belongs to the web starter and moves with it. The build reads
`docs/`, the root `index.html` and `scripts/markdown.mjs`, none of which are in
`apps/web/`: a product gets `docs/sops.md` and `scripts/markdown.mjs` from the
engine and a `docs/data-governance.md` written when it is assembled
(`catalogue.json`). It has no `docs/adoption.md` or root `index.html`, those
being the base repository's own, so the build skips those two pages and the
product publishes neither: nothing stands in for them. A page added to
`MARKDOWN_PAGES` whose source a product will not have is skipped there the same
way.

`scripts/markdown.mjs` renders a deliberate subset. Check what it supports
before using a construct; an unsupported one renders as literal text.
