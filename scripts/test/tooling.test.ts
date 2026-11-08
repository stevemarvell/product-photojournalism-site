import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apps, loadProject } from '../project.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Manifest = {
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const read = (dir: string): Manifest => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Manifest;
const declared = (m: Manifest) => ({ ...m.dependencies, ...m.devDependencies });

// The workspace directories an entry names. "apps/*" is a glob so the root
// names no app; npm takes the directories under it that hold a
// package.json, and so does this.
const expand = (entry: string): string[] => {
  if (!entry.endsWith('/*')) return [entry];
  const parent = entry.slice(0, -2);
  return readdirSync(join(ROOT, parent), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, parent, d.name, 'package.json')))
    .map((d) => `${parent}/${d.name}`);
};

// The root declares the AI layer's own test tools at the same versions
// a workspace may also use, so npm installs one copy. Nothing else keeps the
// two declarations equal: bump one and npm quietly installs two, and
// verify:harness and the app's own checks run different versions of the same
// tool. Written against every workspace, not a named app, so it holds
// whatever the application is.
describe('shared tool versions', () => {
  it('match wherever the root and a workspace declare the same package', () => {
    const root = read('.');
    const rootDeps = declared(root);
    // An engine-only product has no apps, so no workspaces for the root to
    // name; every other project must have some, or nothing below is compared.
    if (Object.keys(loadProject().apps).length === 0) {
      expect(root.workspaces).toBeUndefined();
      return;
    }
    expect(root.workspaces?.length ?? 0).toBeGreaterThan(0);
    const mismatches: string[] = [];
    const workspaces = (root.workspaces ?? []).flatMap(expand);
    // A product with no node app has no workspace to compare, and says so in
    // project.json; any other product must have found its apps, or this check
    // would pass having compared nothing.
    if (apps(loadProject(), 'node').length > 0) expect(workspaces.length).toBeGreaterThan(0);
    for (const workspace of workspaces) {
      for (const [name, version] of Object.entries(declared(read(workspace)))) {
        if (name in rootDeps && rootDeps[name] !== version) {
          mismatches.push(`${name}: root ${rootDeps[name]}, ${workspace} ${version}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('are declared by the root at all, so the AI layer does not borrow an app install', () => {
    const rootDeps = declared(read('.'));
    for (const tool of ['vitest', 'typescript', 'eslint', 'typescript-eslint', '@eslint/js', '@types/node']) {
      expect(rootDeps, tool).toHaveProperty(tool);
    }
  });
});
