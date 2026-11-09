import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string }[];
};

describe('vercel.json rewrites', () => {
  it('serves index.html for /editor and everything under it', () => {
    expect(config.rewrites).toContainEqual({ source: '/editor/:path*', destination: '/index.html' });
  });
  it('keeps the /api rewrite that sign-in depends on', () => {
    const api = config.rewrites.find((r) => r.source === '/api/:path*');
    expect(api?.destination).toMatch(/^https:\/\/.+\/:path\*$/);
  });
});

describe('vercel.json rewrite for the public pages', () => {
  const page = config.rewrites.find((r) => r.destination === '/index.html' && r.source.startsWith('/:id('));
  // path-to-regexp's `/:id(<re>)` is the regex on one whole path segment.
  const matches = (path: string): boolean => {
    const re = /^\/:id\((.*)\)$/.exec(page?.source ?? '')?.[1];
    return re !== undefined && new RegExp(`^/(?:${re})$`).test(path);
  };
  it('serves index.html for /<uuid>', () => {
    expect(page).toBeDefined();
    expect(matches('/3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b')).toBe(true);
  });
  it('does not capture the other first segments: /api, /editor, /docs, /assets', () => {
    for (const path of ['/api', '/editor', '/docs', '/assets', '/health', '/']) expect(matches(path)).toBe(false);
  });
  it('lists /api and /editor before it, since rewrites apply in order', () => {
    const at = (s: string) => config.rewrites.findIndex((r) => r.source === s);
    expect(at('/api/:path*')).toBeGreaterThanOrEqual(0);
    expect(at('/api/:path*')).toBeLessThan(config.rewrites.indexOf(page!));
    expect(at('/editor/:path*')).toBeLessThan(config.rewrites.indexOf(page!));
  });
});
