import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDocs, indexPage, listing, MARKDOWN_PAGES, plannedPages } from '../scripts/build-docs.mjs';

// A stand-in repository, so a test never depends on what docs/ happens to say
// today — only on what the build does with it.
let root = '';
let out = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'docs-root-'));
  out = join(mkdtempSync(join(tmpdir(), 'docs-out-')), 'docs');

  mkdirSync(join(root, 'docs'), { recursive: true });

  // A name distinct from this repository's own, so a test proving the build
  // reads it dynamically cannot pass by accident the way a hardcoded name
  // would.
  writeFileSync(join(root, 'project.json'), JSON.stringify({ name: 'stand-in-app' }));
  writeFileSync(join(root, 'docs', 'adoption.md'), '# Stages\n\nA **step**.\n\n- [ ] a gap\n');
  writeFileSync(join(root, 'docs', 'data-governance.md'), '# Governance\n\nInvented *data*.\n');
  writeFileSync(join(root, 'docs', 'sops.md'), '# Procedures\n\nBounded `loops`.\n');
  writeFileSync(join(root, 'index.html'), '<h1>Hello, world</h1>\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const build = (env: Record<string, string | undefined> = {}) => buildDocs({ root, out, env });
const read = (name: string) => readFileSync(join(out, name), 'utf8');

describe('buildDocs', () => {
  it('renders every Markdown page', () => {
    const result = build();

    expect(result.written).toEqual(
      expect.arrayContaining([
        'adoption.html',
        'data-governance.html',
        'sops.html',
        'index.html',
        'step-0.html',
      ]),
    );
    expect(read('adoption.html')).toContain('<strong>step</strong>');
    expect(read('adoption.html')).toContain('<input type="checkbox" disabled> a gap');
    expect(read('data-governance.html')).toContain('<em>data</em>');
    expect(read('sops.html')).toContain('<code>loops</code>');
  });

  it("publishes the build's commit for smoke's web freshness gate", () => {
    build({ VERCEL_GIT_COMMIT_SHA: 'abc123' });
    expect(JSON.parse(read('version.json'))).toEqual({ commit: 'abc123' });
  });

  it('publishes an empty commit outside Vercel rather than a stale one', () => {
    build({});
    expect(JSON.parse(read('version.json'))).toEqual({ commit: '' });
  });

  it('titles each page from its own first heading', () => {
    build();
    expect(read('adoption.html')).toContain('<title>Stages</title>');
    expect(read('data-governance.html')).toContain('<title>Governance</title>');
    expect(read('sops.html')).toContain('<title>Procedures</title>');
    expect(read('index.html')).toContain('>Stages</a>');
    expect(read('index.html')).toContain('>Governance</a>');
    expect(read('index.html')).toContain('>Procedures</a>');
  });

  it("titles the site from project.json's name, not a hardcoded one", () => {
    // stand-in-app is this fixture's name, not this repository's own — so
    // this would fail if the build ever went back to a hardcoded name.
    build();
    expect(read('index.html')).toContain('<h1>stand-in-app docs</h1>');
    expect(read('adoption.html')).toContain('<a href="./">stand-in-app docs</a>');
  });

  it('lists the documents in the order the build script declares them', () => {
    // The index is the way in, so the order it shows is a choice rather than
    // whatever the filesystem returns.
    build();
    const index = read('index.html');
    expect(index.indexOf('adoption.html')).toBeLessThan(index.indexOf('data-governance.html'));
    expect(index.indexOf('data-governance.html')).toBeLessThan(index.indexOf('sops.html'));
  });

  it('publishes the step-0 page exactly as it was written', () => {
    // It is a record of what this project looked like at step 0, not a page to
    // restyle.
    build();
    expect(read('step-0.html')).toBe('<h1>Hello, world</h1>\n');
  });

  it('clears the output directory, so a removed page cannot linger', () => {
    build();
    writeFileSync(join(out, 'stale.html'), 'from an older build');
    build();
    expect(existsSync(join(out, 'stale.html'))).toBe(false);
  });

  it('builds into a directory that does not exist yet', () => {
    rmSync(out, { recursive: true, force: true });
    expect(() => build()).not.toThrow();
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  });

  it('skips a document whose source is absent: no page, no card, no placeholder', () => {
    rmSync(join(root, 'docs', 'adoption.md'));
    const result = build();

    expect(result.skipped).toEqual([join('docs', 'adoption.md')]);
    expect(result.written).not.toContain('adoption.html');
    expect(existsSync(join(out, 'adoption.html'))).toBe(false);
    // The pages that are there still build, and the index lists only those.
    expect(result.written).toEqual(expect.arrayContaining(['data-governance.html', 'sops.html', 'step-0.html']));
    expect(read('index.html')).not.toContain('adoption.html');
    expect(read('index.html')).toContain('href="sops.html"');
  });

  it('skips the step-0 page when there is no root index.html', () => {
    rmSync(join(root, 'index.html'));
    const result = build();

    expect(result.skipped).toEqual(['index.html']);
    expect(result.written).not.toContain('step-0.html');
    expect(existsSync(join(out, 'step-0.html'))).toBe(false);
    expect(read('index.html')).not.toContain('step-0.html');
    expect(read('index.html')).toContain('href="adoption.html"');
  });

  it('builds a product that has only the pages the engine and the generator give it', () => {
    rmSync(join(root, 'docs', 'adoption.md'));
    rmSync(join(root, 'index.html'));
    const result = build();

    expect(result.skipped).toEqual([join('docs', 'adoption.md'), 'index.html']);
    expect([...result.written].sort()).toEqual(['data-governance.html', 'index.html', 'sops.html', 'version.json']);
  });

  it('reports nothing skipped when every source is there', () => {
    expect(build().skipped).toEqual([]);
  });
});

describe('plannedPages and listing: what smoke.sh expects served', () => {
  it('plans exactly the pages a build writes, each with its own first heading', () => {
    const { pages, skipped } = plannedPages({ root });
    expect(skipped).toEqual([]);
    expect(pages.map((p) => [p.page, p.title])).toEqual([
      ['adoption.html', 'Stages'],
      ['data-governance.html', 'Governance'],
      ['sops.html', 'Procedures'],
      ['step-0.html', null],
    ]);
    const written = build().written.filter((f) => f.endsWith('.html') && f !== 'index.html');
    expect(pages.map((p) => p.page)).toEqual(written);
  });

  it('leaves out a base-only page whose source is absent, as a product has it', () => {
    rmSync(join(root, 'docs', 'adoption.md'));
    rmSync(join(root, 'index.html'));
    expect(plannedPages({ root }).pages.map((p) => p.page)).toEqual(['data-governance.html', 'sops.html']);
    expect(listing({ root }).split('\n')).toEqual([
      'data-governance.html\t<title>Governance</title>',
      'sops.html\t<title>Procedures</title>',
    ]);
  });

  it('lists the title exactly as the built page carries it, escaped, and nothing for step-0', () => {
    writeFileSync(join(root, 'docs', 'sops.md'), '# Plans & `loops` <b>\n');
    build();
    const lines = Object.fromEntries(listing({ root }).split('\n').map((l) => l.split('\t') as [string, string]));
    // Step-0 is marked by its own <h1>, which an app shell served in its place lacks.
    expect(lines['step-0.html']).toBe('<h1>Hello, world</h1>');
    expect(read('sops.html')).toContain(lines['sops.html']);
  });

  it('refuses to list step-0 with nothing to check it by, rather than leave it unchecked', () => {
    writeFileSync(join(root, 'index.html'), '<title>x</title><p>no heading</p>');
    expect(() => listing({ root })).toThrow(/step-0\.html/);
  });

  it('plans nothing it does not hold: with no sources the list is empty, which smoke.sh refuses', () => {
    rmSync(join(root, 'docs'), { recursive: true });
    rmSync(join(root, 'index.html'));
    expect(listing({ root })).toBe('');
  });
});

describe('indexPage', () => {
  it('lists every document', () => {
    const html = indexPage(
      [{ slug: 'adoption', title: 'Stages', blurb: 'the ladder' }],
      'stand-in-app',
    );
    expect(html).toContain('href="adoption.html"');
    expect(html).toContain('href="step-0.html"');
  });

  it('leaves out the step-0 card when there is no step-0 page', () => {
    const html = indexPage([{ slug: 'adoption', title: 'Stages', blurb: 'the ladder' }], 'stand-in-app', {
      stepZero: false,
    });
    expect(html).toContain('href="adoption.html"');
    expect(html).not.toContain('step-0.html');
  });

  it('escapes what it puts into the page, including the project name', () => {
    const html = indexPage([{ slug: 'x', title: '<script>', blurb: 'a & b' }], '<b>app</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;b&gt;app&lt;/b&gt; docs');
  });
});

describe('the pages this repository actually publishes', () => {
  // Skipping an absent page is what lets a product build; it is also what would
  // hide a renamed document here. catalogue.json exists only in the base, which
  // is the one repository that must hold every page.
  const repo = join(__dirname, '..', '..', '..');
  const isBase = existsSync(join(repo, 'catalogue.json'));

  it('names the real source files, all of them in the base', () => {
    // A renamed doc should break here rather than at deploy time.
    for (const entry of MARKDOWN_PAGES) {
      if (isBase) expect(existsSync(join(repo, entry.source)), entry.source).toBe(true);
    }
    if (isBase) expect(existsSync(join(repo, 'index.html'))).toBe(true);
  });

  it('has the documents the engine and the generated files give every project', () => {
    // Holds in a product as well as the base: without them the docs site would
    // be an index of nothing and this suite would still be green.
    for (const source of [join('docs', 'sops.md'), join('docs', 'data-governance.md')]) {
      expect(existsSync(join(repo, source)), source).toBe(true);
    }
  });
});
