import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_API_ORIGIN, previewHeaders, SECURITY_HEADERS } from '../security-headers.mjs';

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

describe('vercel.json security headers', () => {
  const entries = (config as unknown as { headers: { source: string; headers: { key: string; value: string }[] }[] }).headers;
  const sent: Record<string, string> = Object.fromEntries(entries[0]?.headers.map((h) => [h.key, h.value]) ?? []);

  it("has one entry, on every path except /api, which keeps the API's own headers", () => {
    expect(entries).toHaveLength(1);
    const re = new RegExp(`^${entries[0]?.source}$`);
    for (const path of ['/', '/editor', '/editor/abc', '/docs/sops.html', '/assets/x.js']) expect(re.test(path)).toBe(true);
    for (const path of ['/api/health', '/api/auth/me']) expect(re.test(path)).toBe(false);
  });
  it('carries the five headers', () => {
    expect(sent['X-Frame-Options']).toBe('DENY');
    expect(sent['X-Content-Type-Options']).toBe('nosniff');
    expect(sent['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(sent['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(sent['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(sent['Content-Security-Policy']).toContain("script-src 'self';");
    expect(sent['Content-Security-Policy']).toContain("font-src 'self' data:");
    expect(Object.keys(sent)).toHaveLength(5);
  });
  it('lets the browser PUT an original to the Blob API, and to the store, and nowhere else', () => {
    const csp = sent['Content-Security-Policy'] ?? '';
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src ')) ?? '';
    expect(connect).toBe("connect-src 'self' https://*.public.blob.vercel-storage.com https://vercel.com/api/blob/");
  });
  it('agrees with the constant vite preview serves', () => {
    expect(sent).toEqual(SECURITY_HEADERS);
  });
  it('lets preview widen only img-src and connect-src, and only for the e2e API origin', () => {
    const base = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    const preview = previewHeaders()['Content-Security-Policy'] ?? '';
    expect(preview.replaceAll(` ${E2E_API_ORIGIN}`, '')).toBe(base);
    expect(preview.split(E2E_API_ORIGIN)).toHaveLength(3);
  });
});
