import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { apps, loadProject, type Project } from '../project.mjs';

// .github/dependabot.yml is written for each product by scripts/assemble.mjs,
// from the base's own file, keeping the ecosystems the product has. What it
// names has to be true of the repository it lands in: this test reads
// project.json and the tree it sits in, and holds in the base and in a product
// assembled from any starter.
//
// There is no YAML parser among the dependencies and none is added for this:
// the file is read by a small indentation-based reader that understands only
// what the file uses (maps, block and flow lists, scalars, comments). A shape
// it does not understand throws, so the file cannot drift out of what the
// checks below can see.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Node = string | Node[] | { [key: string]: Node } | null;
type Line = { indent: number; text: string };

function scalar(raw: string): Node {
  const text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => scalar(item) as string);
  }
  const quoted = /^(['"])(.*)\1$/.exec(text);
  return quoted ? quoted[2]! : text;
}

/** Parse the YAML subset dependabot.yml is written in. Throws on anything else. */
export function parseYaml(source: string): Node {
  const lines: Line[] = [];
  for (const raw of source.split('\n')) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (raw.includes('\t')) throw new Error('tab indentation');
    const text = raw.replace(/\s+#.*$/, '').trimEnd();
    lines.push({ indent: raw.length - raw.trimStart().length, text: text.trimStart() });
  }
  let at = 0;

  function block(indent: number): Node {
    return lines[at]!.text.startsWith('- ') || lines[at]!.text === '-' ? list(indent) : map(indent);
  }

  function list(indent: number): Node[] {
    const out: Node[] = [];
    while (at < lines.length && lines[at]!.indent === indent && lines[at]!.text.startsWith('- ')) {
      const rest = lines[at]!.text.slice(2).trim();
      if (/^[\w-]+:(\s|$)/.test(rest)) {
        // "- key: value": the item is a map whose first key sits two columns in.
        lines[at] = { indent: indent + 2, text: rest };
        out.push(map(indent + 2));
      } else {
        out.push(scalar(rest));
        at += 1;
      }
    }
    return out;
  }

  function map(indent: number): { [key: string]: Node } {
    const out: { [key: string]: Node } = {};
    while (at < lines.length && lines[at]!.indent === indent && !lines[at]!.text.startsWith('- ')) {
      const found = /^([\w-]+):(?:\s+(.*))?$/.exec(lines[at]!.text);
      if (!found) throw new Error(`cannot read line: ${lines[at]!.text}`);
      const [, key, value] = found;
      at += 1;
      if (value !== undefined && value !== '') out[key!] = scalar(value);
      else {
        const next = lines[at];
        if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) out[key!] = block(next.indent);
        else out[key!] = null;
      }
    }
    return out;
  }

  const result = lines.length ? block(lines[0]!.indent) : null;
  if (at < lines.length) throw new Error(`cannot read line: ${lines[at]!.text}`);
  return result;
}

type Entry = {
  'package-ecosystem'?: string;
  directory?: string;
  directories?: string[];
  schedule?: { interval?: string };
  cooldown?: { 'default-days'?: string };
  groups?: Record<string, { patterns?: string[]; 'update-types'?: string[] }>;
  ignore?: { 'dependency-name'?: string; 'update-types'?: string[] }[];
};

/** Every directory under `root`, as "/a/b", without dependency and VCS trees. */
function directoriesUnder(root: string, rel = '', depth = 0): string[] {
  if (depth > 4) return [];
  return readdirSync(join(root, rel), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !['node_modules', '.git', '.venv', 'dist'].includes(d.name))
    .flatMap((d) => {
      const child = `${rel}/${d.name}`;
      return [child, ...directoriesUnder(root, child, depth + 1)];
    });
}

const isGlob = (pattern: string) => /[*?[]/.test(pattern);

function matcher(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*\*/g, '<<globstar>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<globstar>>/g, '.*');
  return new RegExp(`^${body}$`);
}

const dirsOf = (entry: Entry): string[] => entry.directories ?? (entry.directory ? [entry.directory] : []);

/** The directories of `entry` that exist under `root`; a literal that is missing contributes nothing. */
function resolved(entry: Entry, root: string): string[] {
  const all = directoriesUnder(root);
  return dirsOf(entry).flatMap((pattern) => {
    if (pattern === '/') return ['/'];
    return isGlob(pattern) ? all.filter((dir) => matcher(pattern).test(dir)) : all.filter((dir) => dir === pattern);
  });
}

const exists = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** What is wrong with `source` as a dependabot.yml for the repository at `root`, described by `project`. Empty when nothing is. */
export function problems(source: string, project: Project, root: string): string[] {
  const out: string[] = [];
  const config = parseYaml(source) as { version?: string; updates?: Entry[] } | null;
  const updates = config?.updates ?? [];
  if (config?.version !== '2') out.push('version is not 2');
  if (updates.length === 0) out.push('no updates');

  const entries = (ecosystem: string) => updates.filter((entry) => entry['package-ecosystem'] === ecosystem);

  // Nothing names a path that does not exist. A glob must find a directory;
  // a literal must be one.
  for (const entry of updates) {
    const name = entry['package-ecosystem'] ?? '?';
    if (dirsOf(entry).length === 0) out.push(`${name}: no directory`);
    if (entry.directory && isGlob(entry.directory)) out.push(`${name}: a glob in "directory" is not supported, use "directories"`);
    for (const pattern of dirsOf(entry)) {
      if (pattern !== '/' && resolved({ directories: [pattern] }, root).length === 0) out.push(`${name}: "${pattern}" matches no directory`);
    }
    if (entry.schedule?.interval !== 'weekly') out.push(`${name}: not weekly`);
  }

  // One manifest, one entry: overlapping directories within an ecosystem are not allowed.
  for (const ecosystem of new Set(updates.map((entry) => entry['package-ecosystem']))) {
    const seen = new Set<string>();
    for (const entry of entries(ecosystem ?? '')) {
      for (const dir of resolved(entry, root)) {
        if (seen.has(dir)) out.push(`${ecosystem}: "${dir}" is covered twice`);
        seen.add(dir);
      }
    }
  }

  // Every Python app is covered by a uv entry, and has what uv needs there.
  const uv = entries('uv');
  for (const [name, app] of apps(project, 'python')) {
    const dir = `/${app.path}`;
    if (!uv.some((entry) => resolved(entry, root).includes(dir))) out.push(`python app "${name}" (${dir}) is covered by no uv entry`);
    for (const file of ['pyproject.toml', 'uv.lock']) {
      if (!exists(join(root, app.path, file))) out.push(`python app "${name}" has no ${file}`);
    }
  }

  // Every uv glob must find a directory holding a pyproject.toml. Dependabot
  // skips a directory with no manifest but fails the job when none of the
  // directories has one (dependabot-core, file_fetcher_command.rb), so a
  // product with no Python app is red here on purpose: a file with a uv entry
  // cannot fit it. assemble.mjs leaves the entry out of such a product (#236).
  for (const entry of uv) {
    for (const pattern of dirsOf(entry)) {
      const found = resolved({ directories: [pattern] }, root);
      if (found.length > 0 && !found.some((dir) => exists(join(root, dir, 'pyproject.toml')))) {
        out.push(`uv: "${pattern}" matches no directory holding a pyproject.toml`);
      }
    }
  }

  // The node workspace is covered by the npm entry at the root, and its members
  // are reached through that entry, not listed beside it.
  const npm = entries('npm');
  const rootManifestPath = join(root, 'package.json');
  if (exists(rootManifestPath)) {
    const manifest = JSON.parse(readFileSync(rootManifestPath, 'utf8')) as { workspaces?: string[] };
    if (!npm.some((entry) => dirsOf(entry).includes('/'))) out.push('the root package.json is covered by no npm entry');
    const patterns = manifest.workspaces ?? [];
    for (const [name, app] of apps(project, 'node')) {
      if (!patterns.some((pattern) => matcher(pattern).test(app.path))) out.push(`node app "${name}" (${app.path}) is not a workspace of the root package.json`);
      if (npm.some((entry) => resolved(entry, root).includes(`/${app.path}`))) out.push(`node app "${name}" has an npm entry of its own beside the workspace root`);
    }
  } else if (npm.length > 0) {
    out.push('an npm entry, but no root package.json');
  }

  // Each new ecosystem groups minor and patch updates, and not major ones:
  // a major is opened on its own.
  for (const [ecosystem, found] of [['npm', npm], ['uv', uv]] as const) {
    // npm is in every product; uv only where there is a Python app, which the check above has already held to a uv entry.
    if (found.length === 0 && (ecosystem === 'npm' || apps(project, 'python').length > 0)) out.push(`${ecosystem}: no entry`);
    for (const entry of found) {
      const groups = Object.values(entry.groups ?? {});
      const grouped = groups.some((group) => {
        const types = [...(group['update-types'] ?? [])].sort();
        return (group.patterns ?? []).includes('*') && types.join() === 'minor,patch';
      });
      if (!grouped) out.push(`${ecosystem}: no group of every dependency limited to minor and patch updates`);
    }
  }

  // The cooldown delays proposing a new release, so a yanked or malicious one can be pulled first; held at three days or more.
  for (const [ecosystem, found] of [['npm', npm], ['uv', uv]] as const) {
    for (const entry of found) {
      if (!(Number(entry.cooldown?.['default-days']) >= 3)) out.push(`${ecosystem}: no cooldown of at least 3 days`);
    }
  }
  return out;
}

const source = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8');

/** The Node major CI runs, from verify.yml's `node-version`. */
const ciNodeMajor = (workflow: string) => /node-version:\s*['"]?(\d+)/.exec(workflow)?.[1];

/** The Node major the @types/node ignore's comment says it holds back from, e.g. "CI runs Node 22". */
const ignoredNodeMajor = (yml: string) => /CI runs Node (\d+)[^]*?dependency-name: '@types\/node'/.exec(yml)?.[1];

describe('the committed .github/dependabot.yml', () => {
  it('reads as the structure the checks expect', () => {
    const config = parseYaml(source) as { updates: Entry[] };
    // The base and a python or both-starters product have a uv entry; a web-only product has none.
    const hasPython = apps(loadProject(), 'python').length > 0;
    expect(config.updates.map((entry) => entry['package-ecosystem'])).toEqual(['github-actions', 'npm', ...(hasPython ? ['uv'] : [])]);
  });

  it('holds for this repository: coverage, groups, and no path that is not there', () => {
    expect(problems(source, loadProject(), ROOT)).toEqual([]);
  });

  it('ignores majors of typescript and @types/node in the npm entry, and only majors', () => {
    const config = parseYaml(source) as { updates: Entry[] };
    const npm = config.updates.find((entry) => entry['package-ecosystem'] === 'npm')!;
    expect(npm.ignore).toEqual([
      { 'dependency-name': 'typescript', 'update-types': ['version-update:semver-major'] },
      { 'dependency-name': '@types/node', 'update-types': ['version-update:semver-major'] },
    ]);
  });

  it("keeps the @types/node ignore in step with verify.yml's node-version", () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/verify.yml'), 'utf8');
    const ci = ciNodeMajor(workflow);
    expect(ci, 'verify.yml has no node-version').toBeDefined();
    expect(
      ignoredNodeMajor(source),
      `verify.yml runs Node ${ci} but the @types/node ignore in dependabot.yml says Node ${ignoredNodeMajor(source)}: if the runtime moved, lift or move the ignore and update its comment`,
    ).toBe(ci);
  });

  it('keeps the github-actions entry as it was: weekly, one group of everything, a ci prefix', () => {
    const config = parseYaml(source) as { updates: (Entry & { 'commit-message'?: { prefix?: string } })[] };
    const actions = config.updates.find((entry) => entry['package-ecosystem'] === 'github-actions')!;
    expect(actions.directory).toBe('/');
    expect(actions.schedule?.interval).toBe('weekly');
    expect(actions.groups).toEqual({ actions: { patterns: ['*'] } });
    expect(actions['commit-message']?.prefix).toBe('ci');
  });
});

// A check that has never been seen to fail is the failure SOP 3 describes, so
// the same checks run here against trees and files built to be wrong.
describe('problems()', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /** A tree with the given files, each holding a placeholder. */
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dependabot-test-'));
    made.push(dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  }

  const rootPackage = JSON.stringify({ name: 'p', workspaces: ['apps/*'] });
  const python = (app = 'api') => ({ [`apps/${app}/pyproject.toml`]: '', [`apps/${app}/uv.lock`]: '' });
  const project = (spec: Record<string, 'python' | 'node'>): Project => ({
    name: 'p',
    apps: Object.fromEntries(Object.entries(spec).map(([name, toolchain]) => [name, { path: `apps/${name}`, toolchain, reads: [] }])),
  });
  const grouped = (name: string) => `    groups:\n      ${name}:\n        patterns:\n          - '*'\n        update-types:\n          - minor\n          - patch\n`;
  const config = (npmExtra = '', uvExtra = '') =>
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: npm',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '    cooldown:',
      '      default-days: 3',
      grouped('n') + npmExtra,
      '  - package-ecosystem: uv',
      '    directories:',
      "      - '/apps/*'",
      '    schedule:',
      '      interval: weekly',
      '    cooldown:',
      '      default-days: 3',
      grouped('u') + uvExtra,
    ].join('\n');

  it('accepts a python-only product and a product with both apps', () => {
    const pythonOnly = tree({ 'package.json': rootPackage, ...python() });
    expect(problems(config(), project({ api: 'python' }), pythonOnly)).toEqual([]);
    const both = tree({ 'package.json': rootPackage, 'apps/web/package.json': '{}', ...python() });
    expect(problems(config(), project({ api: 'python', web: 'node' }), both)).toEqual([]);
  });

  it('flags a python app no uv entry covers', () => {
    const dir = tree({ 'package.json': rootPackage, ...python('api'), ...python('worker') });
    const narrow = config().replace("'/apps/*'", '/apps/api');
    expect(problems(narrow, project({ api: 'python', worker: 'python' }), dir)).toEqual([
      'python app "worker" (/apps/worker) is covered by no uv entry',
    ]);
  });

  it('flags a python app with no uv.lock', () => {
    const dir = tree({ 'package.json': rootPackage, 'apps/api/pyproject.toml': '' });
    expect(problems(config(), project({ api: 'python' }), dir)).toEqual(['python app "api" has no uv.lock']);
  });

  it('flags a node workspace the npm entry does not cover', () => {
    const dir = tree({ 'package.json': rootPackage, ...python() });
    const elsewhere = config().replace('directory: /\n', 'directory: /apps/api\n');
    expect(problems(elsewhere, project({ api: 'python' }), dir)).toContain('the root package.json is covered by no npm entry');
  });

  it('flags a workspace listed beside the root, which is the same manifest twice', () => {
    const dir = tree({ 'package.json': rootPackage, 'apps/web/package.json': '{}' });
    const twice = config().replace('directory: /\n', 'directories:\n      - /\n      - /apps/web\n');
    expect(problems(twice, project({ web: 'node' }), dir)).toContain('node app "web" has an npm entry of its own beside the workspace root');
  });

  it('flags a group that takes major updates, or takes neither minor nor patch', () => {
    const dir = tree({ 'package.json': rootPackage, ...python() });
    const all = config().replace(/\n {8}update-types:\n(?: {10}- \w+\n?)+/g, '\n');
    expect(problems(all, project({ api: 'python' }), dir)).toEqual([
      'npm: no group of every dependency limited to minor and patch updates',
      'uv: no group of every dependency limited to minor and patch updates',
    ]);
    const majorGroup = config().replaceAll('          - patch', '          - patch\n          - major');
    expect(problems(majorGroup, project({ api: 'python' }), dir)).toEqual([
      'npm: no group of every dependency limited to minor and patch updates',
      'uv: no group of every dependency limited to minor and patch updates',
    ]);
  });

  it('flags a uv glob that finds no pyproject.toml, which is a product with no Python app', () => {
    const webOnly = tree({ 'package.json': rootPackage, 'apps/web/package.json': '{}' });
    expect(problems(config(), project({ web: 'node' }), webOnly)).toEqual([
      'uv: "/apps/*" matches no directory holding a pyproject.toml',
    ]);
  });

  it('flags a missing cooldown, or one under three days, on npm and uv', () => {
    const dir = tree({ 'package.json': rootPackage, ...python() });
    const none = config().replaceAll('    cooldown:\n      default-days: 3\n', '');
    expect(problems(none, project({ api: 'python' }), dir)).toEqual(['npm: no cooldown of at least 3 days', 'uv: no cooldown of at least 3 days']);
    const short = config().replaceAll('default-days: 3', 'default-days: 1');
    expect(problems(short, project({ api: 'python' }), dir)).toEqual(['npm: no cooldown of at least 3 days', 'uv: no cooldown of at least 3 days']);
  });

  it('flags a path that does not exist, literal or glob', () => {
    const dir = tree({ 'package.json': rootPackage, ...python() });
    expect(problems(config().replace("'/apps/*'", '/services/api'), project({}), dir)).toContain('uv: "/services/api" matches no directory');
    expect(problems(config().replace("'/apps/*'", "'/services/*'"), project({}), dir)).toContain('uv: "/services/*" matches no directory');
  });

  it('flags a glob in "directory", a missing ecosystem and a schedule that is not weekly', () => {
    const dir = tree({ 'package.json': rootPackage, ...python() });
    expect(problems(config().replace('directory: /\n', "directory: '/*'\n"), project({}), dir)).toContain('npm: a glob in "directory" is not supported, use "directories"');
    expect(problems('version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n', project({ api: 'python' }), dir)).toEqual(
      expect.arrayContaining(['npm: not weekly', 'uv: no entry']),
    );
  });

  it('accepts a web-only product with no uv entry, and flags one with no npm entry', () => {
    const webOnly = tree({ 'package.json': rootPackage, 'apps/web/package.json': '{}' });
    const noUv = config().slice(0, config().indexOf('  - package-ecosystem: uv')).trimEnd();
    expect(problems(noUv, project({ web: 'node' }), webOnly)).toEqual([]);
    const noNpm = noUv.replace(/ {2}- package-ecosystem: npm[\s\S]*$/, '').trimEnd();
    expect(problems(noNpm, project({ web: 'node' }), webOnly)).toEqual(expect.arrayContaining(['npm: no entry']));
  });
});

describe('the @types/node step check', () => {
  it('reads the Node major from both files, and sees them differ', () => {
    expect(ciNodeMajor('      node-version: 22\n')).toBe('22');
    expect(ciNodeMajor("node-version: '24'")).toBe('24');
    expect(ignoredNodeMajor("# CI runs Node 22 (x)\n- dependency-name: '@types/node'")).toBe('22');
    expect(ignoredNodeMajor("# CI runs Node 22 (x)\n- dependency-name: '@types/node'")).not.toBe(ciNodeMajor('node-version: 24'));
  });
});

describe('parseYaml()', () => {
  it('reads maps, block lists, lists beside their key, flow lists, quotes and comments', () => {
    const text = ['a: 1 # note', 'b:', '  - x', "  - 'y z'", 'c:', '  d: [p, q]', '  e:', '  - k: 1', '    l: 2', '  - m'].join('\n');
    expect(parseYaml(text)).toEqual({ a: '1', b: ['x', 'y z'], c: { d: ['p', 'q'], e: [{ k: '1', l: '2' }, 'm'] } });
  });

  it('reads an ignore list with a quoted scope name', () => {
    const text = ['ignore:', '  - dependency-name: typescript', '    update-types:', '      - version-update:semver-major', "  - dependency-name: '@types/node'"].join('\n');
    expect(parseYaml(text)).toEqual({
      ignore: [{ 'dependency-name': 'typescript', 'update-types': ['version-update:semver-major'] }, { 'dependency-name': '@types/node' }],
    });
  });

  it('throws on a line it cannot read rather than skipping it', () => {
    expect(() => parseYaml('a: 1\n  nonsense without a colon')).toThrow(/cannot read line/);
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/tab/);
  });
});
