// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, entryScripts, LIMIT_BYTES } from '../scripts/check-size.mjs';

function dist(sizes: Record<string, number>, lazy: Record<string, number> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'size-'));
  mkdirSync(join(d, 'assets'));
  for (const [f, n] of Object.entries({ ...sizes, ...lazy })) writeFileSync(join(d, f), 'x'.repeat(n));
  const [entry, ...rest] = Object.keys(sizes);
  writeFileSync(
    join(d, 'index.html'),
    `<html><head><script type="module" crossorigin src="/${entry}"></script>` +
      rest.map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`).join('') +
      `<link rel="stylesheet" href="/assets/a.css"></head></html>`,
  );
  return d;
}

describe('check-size', () => {
  it('passes when the entry and its preloads are within the limit, ignoring lazy chunks', () => {
    const d = dist({ 'assets/index-a.js': LIMIT_BYTES - 40_000, 'assets/vendor-b.js': 30_000 }, { 'assets/editor-c.js': 2_000_000 });
    expect(check(d).ok).toBe(true);
  });
  it('fails over the limit and prints the measured size', () => {
    const d = dist({ 'assets/index-a.js': LIMIT_BYTES - 40_000, 'assets/vendor-b.js': 60_000 });
    const r = check(d);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('over the')
    expect(r.message).toContain(`${((LIMIT_BYTES + 20_000) / 1000).toFixed(1)} kB`);
  });
  it('lists the entry script and modulepreloads only', () => {
    expect(entryScripts('<script type="module" src="/a.js"></script><link rel="modulepreload" href="/b.js"><link rel="stylesheet" href="/c.css"><link rel="prefetch" href="/d.js">')).toEqual(['a.js', 'b.js']);
  });
  it('errors when there is no build', () => {
    expect(() => check(mkdtempSync(join(tmpdir(), 'size-')))).toThrow(/npm run build/);
  });
});
