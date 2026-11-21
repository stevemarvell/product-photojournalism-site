// @vitest-environment node
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// apps/web/smoke-site.sh run for real against a local server standing in for the deployment.
type Opts = { list?: [number, string]; bundle?: string; me?: [number, string] };
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(o: Opts): Promise<string> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, type: string, body: string) => (res.writeHead(status, { 'content-type': type }), res.end(body));
    if (path === '/') return send(200, 'text/html', '<script type="module" src="/assets/index-abc.js"></script>');
    if (path === '/assets/index-abc.js') return send(200, 'text/javascript', o.bundle ?? 'a "public-home-body" b');
    const list = o.list ?? [200, '[]'];
    const me = o.me ?? [200, '{"signedIn":false}'];
    if (path === '/api/public/pieces') return send(list[0], 'application/json', list[1]);
    if (path === '/api/auth/me') return send(me[0], 'application/json', me[1]);
    send(404, 'text/plain', 'no');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const run = (web: string) =>
  new Promise<{ code: number; output: string }>((done) => {
    execFile('bash', [join(process.cwd(), 'smoke-site.sh')], { env: { ...process.env, WEB: web, SMOKE_SITE_ATTEMPTS: '2', SMOKE_SITE_INTERVAL: '0' }, timeout: 30_000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: stdout + stderr });
    });
  });

describe('smoke-site.sh', () => {
  it('passes when the list answers through /api, the bundle is the product\'s and sign-in is reachable', async () => {
    const r = await run(await serve({}));
    expect(r.output).toContain('public list answered through /api');
    expect(r.output).toContain("bundle is this product's");
    expect(r.code).toBe(0);
  });
  it('passes a list with pieces in it', async () => {
    expect((await run(await serve({ list: [200, '[{"id":"x"}]'] }))).code).toBe(0);
  });
  it('fails when the list is not a JSON array', async () => {
    const r = await run(await serve({ list: [200, '{"detail":"x"}'] }));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('the public list never answered through /api');
  });
  it('fails when the list answers 502', async () => {
    const r = await run(await serve({ list: [502, '[]'] }));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('the public list never answered through /api');
  });
  it('fails when the bundle lacks the product marker', async () => {
    const r = await run(await serve({ bundle: 'No application here yet' }));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('never carried the public site');
  });
  it('fails when sign-in answers 503', async () => {
    const r = await run(await serve({ me: [503, '{}'] }));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('/api/auth/me never answered signedIn false');
  });
});
