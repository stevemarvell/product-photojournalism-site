// @vitest-environment node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../security-headers.mjs';

// apps/web/smoke-headers.sh run for real against a local server that sends the
// headers as vercel.json does, with one thing wrong on request.
const WEB_DIR = process.cwd();
const ROOT = join(WEB_DIR, '..', '..');

type Mode = 'ok' | 'none' | 'no-frame-options-on-editor' | 'web-csp-on-api';
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(mode: Mode): Promise<string> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/api/health') {
      const csp = mode === 'web-csp-on-api' ? SECURITY_HEADERS['Content-Security-Policy']! : "default-src 'none'; frame-ancestors 'none'";
      res.writeHead(200, { 'content-type': 'application/json', 'content-security-policy': csp });
      return res.end('{}');
    }
    let headers: Record<string, string> = SECURITY_HEADERS;
    if (mode === 'none') headers = {};
    if (mode === 'no-frame-options-on-editor' && path === '/editor') {
      headers = Object.fromEntries(Object.entries(SECURITY_HEADERS).filter(([k]) => k !== 'X-Frame-Options'));
    }
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end('<div id="root"></div>');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const run = (web: string) =>
  new Promise<{ code: number; output: string }>((done) => {
    execFile('bash', [join(WEB_DIR, 'smoke-headers.sh')], { env: { ...process.env, WEB: web }, timeout: 20_000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: stdout + stderr });
    });
  });

describe('smoke-headers.sh', () => {
  it('passes against a host that sends the headers, with the API keeping its own CSP', async () => {
    const result = await run(await serve('ok'));
    expect(result.output).toContain("/api/health keeps the API's own CSP");
    expect(result.code).toBe(0);
  });
  it('fails when the document pages carry no security headers', async () => {
    const result = await run(await serve('none'));
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/\/: Content-Security-Policy is '', expected/);
  });
  it('fails when /editor lacks one of the five headers', async () => {
    const result = await run(await serve('no-frame-options-on-editor'));
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/\/editor: X-Frame-Options is ''/);
  });
  it("fails when /api/health carries the web CSP instead of the API's", async () => {
    const result = await run(await serve('web-csp-on-api'));
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/api\/health CSP is .*expected the API's/);
  });
});

describe('the web smoke entry in project.json', () => {
  const project = JSON.parse(readFileSync(join(ROOT, 'project.json'), 'utf8')) as {
    apps: { web: { smoke: string; ignores: string[] } };
  };
  it('is smoke-deployed.sh, which runs smoke.sh and then smoke-headers.sh', () => {
    expect(project.apps.web.smoke).toBe('apps/web/smoke-deployed.sh');
    const script = readFileSync(join(ROOT, project.apps.web.smoke), 'utf8');
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(script).toContain('smoke.sh"');
    expect(script).toContain('smoke-headers.sh"');
    expect(script.indexOf('smoke.sh"')).toBeLessThan(script.indexOf('smoke-headers.sh"'));
  });
  it('keeps both new scripts out of the web build inputs', () => {
    expect(project.apps.web.ignores).toEqual(expect.arrayContaining(['apps/web/smoke-deployed.sh', 'apps/web/smoke-headers.sh']));
  });
});
