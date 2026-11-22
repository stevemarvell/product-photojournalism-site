import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_API_ORIGIN, previewHeaders, SECURITY_HEADERS } from '../security-headers.mjs';

const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string; has?: { type: string; value: string }[] }[];
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

// Issue #85: the safe default is production. Only the web project's branch aliases that are not
// the production branch (staging and pull request previews) go to the API's staging branch.
// Rewrites apply in order, first match wins, so the develop alias comes before the pattern.
describe('vercel.json /api rewrites: develop alias, branch aliases, then production', () => {
  const apis = config.rewrites.filter((r) => r.source === '/api/:path*');
  const PROD = 'https://photojournalism-site-api-stevemarvell-team.vercel.app/:path*';
  const STAGING = 'https://photojournalism-site-api-git-staging-stevemarvell-team.vercel.app/:path*';
  // What Vercel does with a rewrite: the first whose `has` conditions match; a host value is a
  // regular expression (a plain hostname matches itself, so it is anchored here to mean that).
  const target = (host: string): string | undefined =>
    apis.find((r) =>
      (r.has ?? []).every((c) => c.type === 'host' && new RegExp(c.value.startsWith('^') ? c.value : `^${c.value.replaceAll('.', '\\.')}$`).test(host)),
    )?.destination;

  it('has three, in order: develop alias, branch aliases, unconditional fallback', () => {
    expect(apis).toHaveLength(3);
    expect(apis[0]?.has?.[0]?.value).toBe('photojournalism-site-git-develop-stevemarvell-team.vercel.app');
    expect(apis[1]?.has).toHaveLength(1);
    expect(apis[2]?.has).toBeUndefined();
    expect(apis.map((r) => r.destination)).toEqual([PROD, STAGING, PROD]);
  });
  it('sends the production domains, the develop alias, a production hash URL and a custom domain to production', () => {
    for (const host of [
      'photojournalism-site-stevemarvell-team.vercel.app',
      'photojournalism-portfolio-marvell.vercel.app',
      'photojournalism-site-git-develop-stevemarvell-team.vercel.app',
      'photojournalism-site-5x9k2abcd-stevemarvell-team.vercel.app',
      'photos.example.com',
    ])
      expect(target(host), host).toBe(PROD);
  });
  it('sends the staging alias and a pull request branch alias to staging', () => {
    for (const host of [
      'photojournalism-site-git-staging-stevemarvell-team.vercel.app',
      'photojournalism-site-git-feat-85-thing-stevemarvell-team.vercel.app',
    ])
      expect(target(host), host).toBe(STAGING);
  });
  it('anchors the branch pattern: lookalike hosts stay on production', () => {
    for (const host of [
      'evil-photojournalism-site-git-x-stevemarvell-team.vercel.app',
      'photojournalism-site-git-x-stevemarvell-team.vercel.app.evil.com',
      'photojournalism-site-git-x-stevemarvell-teamXvercel.app',
    ])
      expect(target(host), host).toBe(PROD);
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

// The hosts the policy allows must be the hosts the Blob adapter produces (issue #68). The
// adapter's source is read, not copied, so a change on either side fails here.
describe('the policy matches the Blob adapter', () => {
  const adapter = readFileSync(join(process.cwd(), '..', 'api', 'src', 'api', 'adapters', 'blob.py'), 'utf8');
  const apiUrl = /^API_URL = "([^"]+)"/m.exec(adapter)?.[1] ?? '';
  const hostSuffix = /self\.host = f"\{[^}]+\}(\.[^"]+)"/.exec(adapter)?.[1] ?? '';
  const uploadUrlPath = /upload_url=f"\{self\._api_url\}(\/\?pathname=)/.exec(adapter)?.[1] ?? '';
  const csp = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
  const sources = (name: string): string[] =>
    (csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '').split(' ').slice(1);

  // The CSP source-matching rules this policy uses: `https://*.host` wildcard host, and a
  // path source that ends in `/` matches by prefix.
  const allows = (name: string, url: string): boolean => {
    const u = new URL(url);
    return sources(name).some((s) => {
      if (!s.startsWith('https://')) return false;
      const rest = s.slice('https://'.length);
      const slash = rest.indexOf('/');
      const host = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? '' : rest.slice(slash);
      const hostOk = host.startsWith('*.') ? u.hostname.endsWith(host.slice(1)) && u.hostname.length > host.length - 1 : u.hostname === host;
      return hostOk && (path === '' || (path.endsWith('/') ? u.pathname.startsWith(path) : u.pathname === path));
    });
  };

  it('finds what it reads in the adapter source', () => {
    expect(apiUrl).toBe('https://vercel.com/api/blob');
    expect(hostSuffix).toBe('.public.blob.vercel-storage.com');
    expect(uploadUrlPath).toBe('/?pathname=');
  });
  it('allows the photo host for img-src and connect-src, for any store id', () => {
    for (const id of ['abc123', 'Zq9XyW8vU7tS6rQ5']) {
      const photo = `https://${id.toLowerCase()}${hostSuffix}/web/photo-1.jpg`;
      expect(allows('img-src', photo)).toBe(true);
      expect(allows('connect-src', photo)).toBe(true);
    }
  });
  it('allows the upload URL the adapter issues in connect-src only', () => {
    const upload = `${apiUrl}${uploadUrlPath}originals%2Fabc`;
    expect(allows('connect-src', upload)).toBe(true);
    expect(allows('img-src', upload)).toBe(false);
  });
  it('does not allow other hosts under Blob or Vercel', () => {
    expect(allows('img-src', `https://abc${hostSuffix.replace('.public', '.private')}/x.jpg`)).toBe(false);
    expect(allows('connect-src', 'https://vercel.com/api/other')).toBe(false);
    expect(allows('connect-src', 'https://vercel.com/')).toBe(false);
  });
});
