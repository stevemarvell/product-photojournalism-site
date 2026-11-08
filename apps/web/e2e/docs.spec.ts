import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The deployment's title comes from project.json, not a hardcoded name — so
// this reads the same manifest the build does, rather than asserting a
// literal string that would drift the moment that name changes.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { name: PROJECT_NAME } = JSON.parse(readFileSync(join(PROJECT_ROOT, 'project.json'), 'utf8'));

// What the docs build wrote, which is what Vite copied into the bundle under
// test (the webServer's `npm run build` runs the prebuild first).
const BUILT = join(PROJECT_ROOT, 'apps', 'web', 'public', 'docs');

// The documents a repository can hold, by the page each becomes. This suite
// runs in the repository the starter was written in and in every product
// built from it, and they hold different documents: `docs/adoption.md` and the
// root `index.html` are the former's alone, and a product does not get a
// placeholder for them. So what a repository must publish is what its own
// files say it holds, never a fixed list of the base's pages.
//
// The expectation is read from the sources, not from the build, on purpose: a
// build that quietly stopped producing a page whose source is still there
// would otherwise shrink the expectation with it and stay green.
const MARKDOWN = [
  { page: 'adoption.html', source: 'docs/adoption.md' },
  { page: 'data-governance.html', source: 'docs/data-governance.md' },
  { page: 'sops.html', source: 'docs/sops.md' },
];
const STEP_ZERO = { page: 'step-0.html', source: 'index.html' };

const held = (source: string) => existsSync(join(PROJECT_ROOT, source));
const documents = MARKDOWN.filter((d) => held(d.source)).map((d) => ({
  ...d,
  text: readFileSync(join(PROJECT_ROOT, d.source), 'utf8'),
}));

/** The plain text of a Markdown heading: what the rendered heading's accessible name is. */
const plain = (heading: string) =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();

/** The headings of one level in `markdown`, outside fenced code. */
function headings(markdown: string, level: 1 | 2): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith(`${'#'.repeat(level)} `)) out.push(plain(line.slice(level + 1)));
  }
  return out;
}

// Read when a test runs, not when this file loads: the build that writes these
// is started by the webServer, which is not guaranteed to have finished by the
// time the file is first read.
const produced = () =>
  existsSync(BUILT) ? readdirSync(BUILT).filter((f) => f.endsWith('.html') && f !== 'index.html') : [];

// These run against the built bundle, which is the point: the docs are
// produced by a prebuild step and copied in by Vite, so nothing but a real
// build proves they reach the deployment. The failure this guards against —
// documentation that exists in the repository and nowhere on the web — is
// exactly the one that losing GitHub Pages caused.
test.describe('the docs Vercel serves', () => {
  test('has the documents every project ships, and builds all that the repository holds', () => {
    // The floor. The engine gives every project docs/sops.md and the generator
    // gives it docs/data-governance.md, so an empty docs set is never right,
    // and a spec that only compared produced pages with themselves would pass
    // on one.
    expect(documents.map((d) => d.source)).toEqual(
      expect.arrayContaining(['docs/sops.md', 'docs/data-governance.md']),
    );
    const expected = [...documents.map((d) => d.page), ...(held(STEP_ZERO.source) ? [STEP_ZERO.page] : [])];
    expect(produced().sort()).toEqual(expected.slice().sort());
  });

  test('lists every document at /docs/', async ({ page }) => {
    await page.goto('/docs/');
    await expect(page.getByRole('heading', { name: `${PROJECT_NAME} docs` })).toBeVisible();

    for (const doc of documents) {
      const [title] = headings(doc.text, 1);
      await expect(page.getByRole('link', { name: title, exact: true }), doc.page).toHaveAttribute(
        'href',
        doc.page,
      );
    }
    // …and a page the build wrote is a page the index leads to.
    for (const file of produced()) {
      await expect(page.locator(`a[href="${file}"]`), file).toHaveCount(1);
    }
  });

  for (const doc of documents) {
    test(`renders ${doc.source}, every heading of it, not its Markdown`, async ({ page }) => {
      await page.goto(`/docs/${doc.page}`);
      const [title] = headings(doc.text, 1);
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
      const sections = headings(doc.text, 2);
      expect(sections.length, `${doc.source} has sections to render`).toBeGreaterThan(0);
      for (const section of sections) {
        await expect(
          page.getByRole('heading', { name: section, exact: true, level: 2 }).first(),
          section,
        ).toBeVisible();
      }
      await expect(page.locator('body')).not.toContainText('**');
    });
  }

  if (held(STEP_ZERO.source)) {
    test('still publishes the step-0 page as it was', async ({ page }) => {
      await page.goto(`/docs/${STEP_ZERO.page}`);
      const served = await page.request.get(`/docs/${STEP_ZERO.page}`);
      expect(await served.text()).toBe(readFileSync(join(PROJECT_ROOT, STEP_ZERO.source), 'utf8'));
    });
  }

  test('publishes the operating procedures', async ({ page }) => {
    // An SOP nobody can find is a convention. The declared ceilings are the
    // part worth reaching the deployment, since they are what an agent is
    // expected to obey.
    await page.goto('/docs/sops.html');
    await expect(page.getByRole('heading', { name: 'Standard operating procedures' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'SOP 1: Every loop declares a maximum' }),
    ).toBeVisible();
    await expect(page.locator('table').first()).toBeVisible();

    // The ranking words, for the same reason as the ceilings: an agent is
    // expected to use these three and no others, and a scale nobody can look
    // up is a scale everyone re-invents — which is the thing SOP 5 stops.
    //
    // All three, and against SOP 5's own table rather than the page: the first
    // version asserted two of them on `body`, so dropping the `high` row would
    // have left this green, and either of the other two would have passed on
    // the word appearing in a sentence elsewhere. A test for "the scale
    // reaches the deployment" has to fail when a row leaves it.
    const sop5 = page.getByRole('heading', { name: 'SOP 5: One scale ranks everything' });
    await expect(sop5).toBeVisible();

    // The table *after that heading*, not the last one on the page. Document
    // position would tie this to SOP 5 only until a SOP 6 with a table of its
    // own is appended, at which point it would quietly assert against the
    // wrong table rather than failing.
    const scale = sop5.locator('xpath=following::table[1]');
    for (const rank of ['critical', 'high', 'medium']) {
      await expect(scale).toContainText(rank);
    }

    // SOP 6 is the one an agent is most likely to act on without reading, so
    // it is the one most worth proving is readable by someone who has not.
    // (It also now follows SOP 5, which is why the locator above stopped
    // being `table.last()`.)
    await expect(
      page.getByRole('heading', { name: 'SOP 6: Decide and act; report after' }),
    ).toBeVisible();
    await expect(page.locator('body')).toContainText('recoverability, not scope');

    // SOP 7 names two files, and the whole rule is which of them is reviewed.
    // A published copy missing the untracked one would read as advice about a
    // single file, which is the opposite of what it says.
    await expect(
      page.getByRole('heading', { name: 'SOP 7: An approval belongs where it can be reviewed' }),
    ).toBeVisible();
    for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
      await expect(page.locator('body')).toContainText(file);
    }
  });
});
