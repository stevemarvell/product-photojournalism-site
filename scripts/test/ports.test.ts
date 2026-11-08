import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portOffset, ports } from '../ports.mjs';

const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ports', () => {
  // Timeout: spawns node (49 ms quiet); 15 s.
  it('does not depend on the working directory', { timeout: 15_000 }, () => {
    // Playwright resolves its config with cwd = apps/web, the same string in
    // every worktree. A cwd-derived offset gave every checkout identical ports
    // and let two agents silently share one server. This suite runs from the
    // repository root, so compute the ports in a process started
    // elsewhere, with the E2E overrides cleared.
    const url = pathToFileURL(join(WORKTREE_ROOT, 'scripts', 'ports.mjs')).href;
    const env = { ...process.env };
    delete env['E2E_API_PORT'];
    delete env['E2E_WEB_PORT'];
    const fromElsewhere = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(url)}).then((m) => process.stdout.write(JSON.stringify(m.ports(['api', 'web']))))`],
      { cwd: tmpdir(), encoding: 'utf8', env, input: '' },
    );
    expect(JSON.parse(fromElsewhere)).toEqual(ports(['api', 'web'], WORKTREE_ROOT));
  });

  it('gives different worktrees different ports', () => {
    expect(ports(['api', 'web'], '/somewhere/repo')).not.toEqual(ports(['api', 'web'], '/somewhere/repo-other'));
  });

  it('keeps the two ranges disjoint', () => {
    for (const root of ['/a/one', '/a/two', '/a/three', '/a/four']) {
      const { api, web } = ports(['api', 'web'], root);
      expect(api).toBeGreaterThanOrEqual(8200);
      expect(api).toBeLessThan(8400);
      expect(web).toBeGreaterThanOrEqual(8600);
      expect(web).toBeLessThan(8800);
    }
  });

  it('lets the environment override', () => {
    vi.stubEnv('E2E_API_PORT', '9001');
    vi.stubEnv('E2E_WEB_PORT', '9002');
    expect(ports(['api', 'web'])).toEqual({ api: 9001, web: 9002 });
  });

  it('is stable for the same root', () => {
    expect(ports(['api', 'web'], '/a/one')).toEqual(ports(['api', 'web'], '/a/one'));
  });

  it('gives each named server its own band, in the order named', () => {
    const offset = portOffset('/a/one');
    expect(ports(['first', 'second', 'third'], '/a/one')).toEqual({
      first: 8200 + offset,
      second: 8600 + offset,
      third: 9000 + offset,
    });
    // One server alone takes the first band.
    expect(ports(['only'], '/a/one')).toEqual({ only: 8200 + offset });
  });

  it("reads each server's override from E2E_<NAME>_PORT", () => {
    vi.stubEnv('E2E_SECOND_PORT', '9100');
    const placed = ports(['first', 'second'], '/a/one');
    expect(placed.second).toBe(9100);
    expect(placed.first).toBe(8200 + portOffset('/a/one'));
  });

  it('refuses to place nothing, rather than guessing which servers exist', () => {
    expect(() => ports([], '/a/one')).toThrow(/names/);
  });
});
