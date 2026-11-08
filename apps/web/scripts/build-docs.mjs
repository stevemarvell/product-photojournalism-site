// Build the documentation site that Vercel serves alongside the web app.
//
// GitHub Pages needs a paid plan on a private repository, so the step-0
// page and the Markdown under docs/ are rendered into apps/web/public/docs
// instead, which Vite copies verbatim into the bundle, so it lands at /docs
// on the Vercel deployment.
//
// The output directory is generated and gitignored. It is deleted and rebuilt
// on every run, so a page removed from this script cannot linger in a build.
//
// A page whose source file is absent is skipped, not an error, and not
// replaced with a placeholder: `docs/adoption.md` and the root `index.html`
// belong to the repository this starter was written in, and a product built
// from the starter does not carry them. `buildDocs` reports what it skipped.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { escapeHtml, firstHeading, renderMarkdown } from '../../../scripts/markdown.mjs';

// apps/web/scripts/ -> the repository root, three levels up.
export const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const DOCS_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'docs');

/** The project's own name, read the one place the AI layer declares it. */
function projectName(root) {
  return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).name;
}

/** The Markdown documents, in the order the index lists them. A document whose source is absent is left out of a build. */
export const MARKDOWN_PAGES = [
  {
    slug: 'adoption',
    source: join('docs', 'adoption.md'),
    blurb: 'The ladder this project is climbing, kept in its original wording.',
  },
  {
    slug: 'data-governance',
    source: join('docs', 'data-governance.md'),
    blurb: 'What the deployments expose, why that is deliberate, and what would change it.',
  },
  {
    slug: 'sops',
    source: join('docs', 'sops.md'),
    blurb: 'How agent work is run here: bounded loops, work that needs a person, and where a control is proven.',
  },
];

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --text: #16181d; --muted: #6d7278;
  --rule: rgba(0,0,0,0.13); --accent: #3880ff; --shade: #f4f5f8; }
@media (prefers-color-scheme: dark) { :root { --bg: #121417; --text: #e9ebf0;
  --muted: #9aa0a8; --rule: rgba(255,255,255,0.16); --accent: #6c9dff; --shade: #1c1f24; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65
  -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 6rem; }
nav.crumbs { font-size: 0.875rem; color: var(--muted); margin-bottom: 2rem; }
a { color: var(--accent); }
a:hover { text-decoration: none; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.015em; }
h1 { font-size: 2rem; margin: 0 0 1.5rem; }
h2 { font-size: 1.4rem; margin: 2.75rem 0 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--rule); }
h3 { font-size: 1.1rem; margin: 2rem 0 0.5rem; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.875em; background: var(--shade); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--shade); padding: 0.9rem 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 0.85em; }
blockquote { margin: 1.5rem 0; padding: 0.1rem 1rem; border-left: 3px solid var(--accent);
  background: var(--shade); border-radius: 0 6px 6px 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; margin: 1.25rem 0; }
th, td { border: 1px solid var(--rule); padding: 0.45rem 0.7rem; text-align: left; vertical-align: top; }
th { background: var(--shade); }
ul.tasks { list-style: none; padding-left: 0.25rem; }
ul.tasks > li.task { margin-bottom: 1rem; }
ul.tasks input { margin-right: 0.4rem; }
del { color: var(--muted); }
.cards { display: grid; gap: 0.9rem; padding: 0; list-style: none; }
.cards a { font-weight: 600; font-size: 1.05rem; text-decoration: none; }
.cards p { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.925rem; }
.cards li { border: 1px solid var(--rule); border-radius: 10px; padding: 0.9rem 1.1rem; }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--rule);
  color: var(--muted); font-size: 0.875rem; }
`.trim();

/** Wraps a rendered fragment in the shared page shell. */
export function page({ title, body, crumbs = true, name }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${crumbs ? `<nav class="crumbs"><a href="./">${escapeHtml(name)} docs</a></nav>\n` : ''}${body}
<footer>Part of the <a href="../">${escapeHtml(name)}</a> deployment. Built from the repository, not from a dashboard.</footer>
</main>
</body>
</html>
`;
}

/**
 * The landing page at /docs/.
 *
 * `rendered` carries each Markdown page's own H1, so the index names a
 * document the way the document names itself.
 */
export function indexPage(rendered = [], name, { stepZero = true } = {}) {
  const cards = [
    ...rendered.map((entry) => ({
      href: `${entry.slug}.html`,
      title: entry.title,
      blurb: entry.blurb,
    })),
    ...(stepZero
      ? [
          {
            href: 'step-0.html',
            title: 'The step-0 page',
            blurb: 'The first artifact this project ever published, kept as it was.',
          },
        ]
      : []),
  ];

  const body = `<h1>${escapeHtml(name)} docs</h1>
<p>Everything this project publishes about itself, built from the repository
into this deployment so a private repository can still publish it.</p>
<ul class="cards">
${cards
  .map(
    (card) =>
      `<li><a href="${escapeHtml(card.href)}">${escapeHtml(card.title)}</a><p>${escapeHtml(card.blurb)}</p></li>`,
  )
  .join('\n')}
</ul>`;

  return page({ title: `${name} docs`, body, crumbs: false, name });
}

/**
 * The pages a build of `root` publishes, in the order the index lists them,
 * and the sources it skips because they are absent. Read from the sources, so
 * it is the one answer both the build and `apps/web/smoke.sh` use: what smoke
 * expects to find served is exactly what the build was going to publish.
 *
 * `title` is each Markdown page's own first heading (null for step-0, which
 * is served as it was written and has none the build reads).
 */
export function plannedPages({ root = REPO_ROOT } = {}) {
  const pages = [];
  const skipped = [];

  for (const entry of MARKDOWN_PAGES) {
    if (!existsSync(join(root, entry.source))) {
      skipped.push(entry.source);
      continue;
    }
    const markdown = readFileSync(join(root, entry.source), 'utf8');
    pages.push({ ...entry, page: `${entry.slug}.html`, title: firstHeading(markdown) ?? entry.slug, markdown });
  }

  // The step-0 artifact is published as it was written, not restyled: it is a
  // record of what this project looked like at step 0.
  if (existsSync(join(root, 'index.html'))) {
    pages.push({ slug: 'step-0', page: 'step-0.html', source: 'index.html', title: null });
  } else {
    skipped.push('index.html');
  }

  return { pages, skipped };
}

/**
 * Renders the whole docs site into `out`, returning the paths written relative
 * to it — so a test can assert what a build produces without re-reading it —
 * and the sources it skipped because they are absent.
 */
export function buildDocs({ root = REPO_ROOT, out = DOCS_DIR, env = process.env } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const name = projectName(root);
  const written = [];
  const rendered = [];
  const { pages, skipped } = plannedPages({ root });

  for (const entry of pages) {
    if (entry.slug === 'step-0') {
      writeFileSync(join(out, entry.page), readFileSync(join(root, entry.source), 'utf8'), 'utf8');
    } else {
      const body = renderMarkdown(entry.markdown);
      writeFileSync(join(out, entry.page), page({ title: entry.title, body, name }), 'utf8');
      rendered.push({ ...entry, title: entry.title });
    }
    written.push(entry.page);
  }
  const stepZero = pages.some((entry) => entry.slug === 'step-0');

  writeFileSync(join(out, 'index.html'), indexPage(rendered, name, { stepZero }), 'utf8');
  written.push('index.html');

  // The commit this build is of, for smoke.yml's web freshness gate — the web
  // counterpart of the API's /health `commit`. Vercel's ignore step can skip a
  // web build (scripts/deploy/vercel/vercel-ignore.mjs), so "is the deployed bundle one
  // whose inputs match this commit's?" needs something to ask. Empty outside
  // Vercel, where there is no deployment to ask about.
  const commit = env['VERCEL_GIT_COMMIT_SHA'] ?? '';
  writeFileSync(join(out, 'version.json'), JSON.stringify({ commit }) + '\n', 'utf8');
  written.push('version.json');

  return { out, written, skipped };
}

/**
 * What `--list` prints, one line per page: the file name, a tab, and the text
 * the served page must contain. For a Markdown page that is the `<title>` the
 * build gives it (its own first heading, escaped). Step-0 is served as written,
 * so it is the source's own first `<h1>`: not its `<title>`, which a host that
 * answers a missing file with the app shell and a 200 would satisfy, the
 * shell's title being the project's name too. A page with nothing to mark it
 * by is an error here, never an empty expectation smoke.sh would skip.
 */
export function listing({ root = REPO_ROOT } = {}) {
  return plannedPages({ root })
    .pages.map((entry) => {
      if (entry.title !== null) return `${entry.page}\t<title>${escapeHtml(entry.title)}</title>`;
      const source = readFileSync(join(root, entry.source), 'utf8');
      const marker = /<h1\b[^>\n\t]*>[^\n\t]*?<\/h1>/i.exec(source)?.[0];
      if (!marker) throw new Error(`${entry.source} has no single-line <h1> to check ${entry.page} by`);
      return `${entry.page}\t${marker}`;
    })
    .join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--list')) {
    // Writes nothing: smoke.sh asks what a build of this checkout publishes.
    console.log(listing());
    process.exit(0);
  }
  const { out, written, skipped } = buildDocs();
  console.log(`built ${written.length} doc pages into ${out}`);
  if (skipped.length > 0) console.log(`skipped, as absent here: ${skipped.join(', ')}`);
}
