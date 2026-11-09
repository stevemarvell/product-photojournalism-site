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
