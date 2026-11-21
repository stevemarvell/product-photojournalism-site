import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { worktreeFiles } from '../git-files.mjs';
import { declaredExports, runtimeExports } from './declarations-parse';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Problems for one .d.mts and the .mjs beside it, each naming the file. */
function compare(dmts: string, root: string): string[] {
  const mjs = dmts.replace(/\.d\.mts$/, '.mjs');
  if (!existsSync(join(root, mjs))) return [`${dmts}: orphan, no ${mjs} beside it`];
  const runtime = runtimeExports(readFileSync(join(root, mjs), 'utf8'));
  const declared = declaredExports(readFileSync(join(root, dmts), 'utf8'));
  return [
    ...runtime.filter((n) => !declared.includes(n)).map((n) => `${mjs}: export '${n}' is not declared in ${dmts}`),
    ...declared.filter((n) => !runtime.includes(n)).map((n) => `${dmts}: declares '${n}', which ${mjs} does not export`),
  ];
}

/** Problems across a list of .d.mts files. */
function comparePairs(dmtsFiles: string[], root: string): string[] {
  return dmtsFiles.filter((f) => f.endsWith('.d.mts')).flatMap((p) => compare(p, root));
}

function withDir(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dmts-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('declarations parsers', () => {
  it('reads every runtime export form', () => {
    const src = `
export function a() {}
export async function b() {}
export const c = 1;
export let d = 2;
export class E {}
export {
  f,
  g as h,
};
// export const commented = 1;
/* export function blockCommented() {} */
export default function () {}
`;
    expect(runtimeExports(src)).toEqual(['E', 'a', 'b', 'c', 'd', 'default', 'f', 'h']);
  });

  it('does not let a glob in a line comment open a block comment', () => {
    const src = '// - .claude/**  holds rubrics\nexport const kept = 1;\n/** doc */\n';
    expect(runtimeExports(src)).toEqual(['kept']);
  });

  it('keeps a // or glob inside a string from acting as a comment', () => {
    const src = "const G = ['.claude/**', 'a // b'];\nexport const one = 1;\nconst T = `\nexport const fake = 1;\n`;\nexport const two = 2; // tail */\n";
    expect(runtimeExports(src)).toEqual(['one', 'two']);
  });

  it('keeps a quote or backtick inside a regex literal from opening a string', () => {
    const src = "const Q = text.replace(/\"/g, '&quot;').replace(/(`+)x/g, 'y');\nexport const kept = 1;\n";
    expect(runtimeExports(src)).toEqual(['kept']);
  });

  it('refuses export forms it cannot read rather than missing names', () => {
    expect(() => runtimeExports("export * from './x.mjs';\n")).toThrow(/unsupported export form/);
    expect(() => runtimeExports('export const { a, b } = obj;\n')).toThrow(/unsupported export form/);
    expect(() => declaredExports('export declare const [a]: number[];\n')).toThrow(/unsupported export form/);
  });

  it('reads declared value exports and skips types', () => {
    const src = `
export function a(): void;
export declare function b(): void;
export const c: number;
export declare const d: number;
export class E {}
export type T = string;
export interface I {}
export { f, type U, g as h };
export default x;
`;
    expect(declaredExports(src)).toEqual(['E', 'a', 'b', 'c', 'd', 'default', 'f', 'h']);
  });
});

describe('declarations match exports', () => {
  // Timeout: one file-listing spawn (about 30 ms quiet); 15 s.
  it('every tracked .d.mts declares the same names its .mjs exports', { timeout: 15_000 }, () => {
    const files = worktreeFiles(ROOT);
    // Guard against comparing nothing (listing failed): this repo has dozens.
    expect(files.filter((f) => f.endsWith('.d.mts')).length).toBeGreaterThan(0);
    expect(comparePairs(files, ROOT)).toEqual([]);
  });

  it('finds nothing to report for a file list with no .d.mts in it', () => {
    expect(comparePairs(['a.mjs', 'README.md'], ROOT)).toEqual([]);
  });

  it('fails naming the file and an undeclared export', () => {
    withDir({ 'x.mjs': 'export const kept = 1;\nexport function extra() {}\n', 'x.d.mts': 'export const kept: number;\n' }, (dir) => {
      expect(compare('x.d.mts', dir)).toEqual(["x.mjs: export 'extra' is not declared in x.d.mts"]);
    });
  });

  it('fails naming the file and a declaration with no export', () => {
    withDir({ 'x.mjs': 'export const kept = 1;\n', 'x.d.mts': 'export const kept: number;\nexport function gone(): void;\n' }, (dir) => {
      expect(compare('x.d.mts', dir)).toEqual(["x.d.mts: declares 'gone', which x.mjs does not export"]);
    });
  });

  it('fails naming an orphan .d.mts', () => {
    withDir({ 'x.d.mts': 'export const kept: number;\n' }, (dir) => {
      expect(compare('x.d.mts', dir)).toEqual(['x.d.mts: orphan, no x.mjs beside it']);
    });
  });
});
