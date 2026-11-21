import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Vercel ignore step and the smoke freshness gate treat the other apps'
// entries in project.json as irrelevant to a build (relevantManifest in
// scripts/project.mjs keeps only the top-level `name` and the app's own entry).
// That holds only while no app's build reads anything else from project.json,
// such as another app's deploy.url. This fails the day one does: widen
// relevantManifest first, then this test.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'build', '.venv', '.vercel', '__pycache__', 'coverage', 'test-results', 'playwright-report', 'public']);
const SOURCE = /\.(m?[jt]sx?|cjs|py|sh|json|ya?ml)$/;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(entry)) yield path;
  }
}

// Every mention of project.json under apps/ must be one of these exact lines,
// each of which reads only the top-level `name`. Anything else, however it is
// spelled (a split read, a helper, an import), fails until it is reviewed
// against relevantManifest and added here. Comment lines are not reads.
const KNOWN_READS: Record<string, string> = {
  'apps/web/vite.config.ts': "const { name: APP_NAME } = JSON.parse(readFileSync(join(REPO_ROOT, 'project.json'), 'utf8'));",
  'apps/web/scripts/build-docs.mjs': "return JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).name;",
};
const HASH_COMMENT = /\.(py|sh|ya?ml)$/;

// What is left of a line once its comment text is removed. Only real comments
// go: a `//` line, a `#` line in a language where `#` starts a comment (`#x` is
// a private field in .ts/.js/.mjs), block-comment text (stripped, not the whole
// line, so `/* x */ import m from '../../project.json'` is still scanned) and
// ` * ` continuation lines.
function codeOf(file: string, line: string): string {
  const t = line.trim();
  if (t.startsWith('//')) return '';
  if (t.startsWith('#') && HASH_COMMENT.test(file)) return '';
  if (/^\*(?!\/)/.test(t)) return '';
  // A `/*` counts as a comment opener only at a token start (line start or after
  // whitespace), so `glob('apps/*/project.json')` and `'a/*' ... '*/'` stay
  // scanned. A leading `*/` closes a comment from an earlier line; the rest is code.
  const body = t.replace(/^\*\//, '').replace(/(^|\s)\/\*.*?\*\//g, '$1');
  return /^\/\*/.test(body) ? '' : body;
}
const isRead = (file: string, line: string) => /project\.(json|mjs)/.test(codeOf(file, line));

describe('apps read nothing but `name` from project.json', () => {
  const hasApps = existsSync(join(ROOT, 'apps'));
  const mentions = (hasApps ? readdirSync(join(ROOT, 'apps')) : [])
    .map((app) => join(ROOT, 'apps', app))
    .filter((dir) => statSync(dir).isDirectory())
    .flatMap((dir) => [...files(dir)])
    .filter((path) => !/\.(test|spec)\.[jt]sx?$/.test(path))
    .flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => isRead(path, line))
        .map((line) => ({ file: relative(ROOT, path).split(sep).join('/'), line })),
    );

  it('skips whole-line comments only', () => {
    expect(isRead('a.ts', '// see project.json')).toBe(false);
    expect(isRead('a.ts', ' * reads project.json')).toBe(false);
    expect(isRead('a.ts', '/* project.json')).toBe(false);
    expect(isRead('a.ts', '/* project.json */')).toBe(false);
    for (const f of ['a.py', 'a.sh', 'a.yml', 'a.yaml']) expect(isRead(f, '# see project.json')).toBe(false);
  });

  it('still scans reads hidden behind a comment or written as a #private field', () => {
    expect(isRead('a.ts', "/* x */ import m from '../../project.json';")).toBe(true);
    expect(isRead('a.mjs', "#m = readFileSync('../../project.json')")).toBe(true);
    expect(isRead('a.js', "#m = readFileSync('../../project.json')")).toBe(true);
    expect(isRead('a.ts', "#m = readFileSync('../../project.json')")).toBe(true);
    expect(isRead('a.ts', "glob('apps/*/project.json')")).toBe(true);
    expect(isRead('a.ts', "x = ['a/*', 'project.json', '*/']")).toBe(true);
    expect(isRead('a.ts', "*/ require('../../project.json')")).toBe(true);
    expect(isRead('a.ts', "/* a */ x = require('project.json') /* b */")).toBe(true);
  });

  it('finds both known readers', () => {
    if (!hasApps) return; // an engine-only product has no apps/ yet
    for (const [file, line] of Object.entries(KNOWN_READS)) {
      expect(mentions, file).toContainEqual({ file, line });
    }
  });

  it('allows no other mention of project.json or project.mjs', () => {
    const unknown = mentions.filter(({ file, line }) => KNOWN_READS[file] !== line);
    expect(unknown).toEqual([]);
  });
});
