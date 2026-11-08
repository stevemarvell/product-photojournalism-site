import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { apps, loadProject, type Project } from '../project.mjs';
import { GATE_ATTEMPTS, appUrls, gateForEvent, smoke, waitForCommit, type FetchJson, type Git } from '../smoke.mjs';

const project = (): Project => ({
  name: 'thing',
  apps: {
    back: {
      path: 'apps/back',
      toolchain: 'python',
      reads: ['apps/back'],
      deploy: { provider: 'vercel', team: 't', project: 'thing-back', url: 'https://back.example', commitEndpoint: '/health' },
      smoke: 'apps/back/smoke.sh',
    },
    front: {
      path: 'apps/front',
      toolchain: 'node',
      reads: ['apps/front'],
      deploy: { provider: 'vercel', team: 't', project: 'thing-front', url: 'https://front.example', commitEndpoint: '/version.json' },
    },
    tool: { path: 'apps/tool', toolchain: 'python', reads: ['apps/tool'] },
  },
});

// Each URL answers from a queue of commits; the last one repeats.
function server(answers: Record<string, (string | Error)[]>) {
  const asked: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    asked.push(url);
    const queue = answers[url] ?? [new Error('404')];
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return { commit: next };
  };
  return { fetchJson, asked };
}

const noSleep = async () => {};
const quiet = () => {};
const gitSays = (status: number): Git => () => ({ status });

describe('appUrls', () => {
  it('names each deployed app upper-cased, and leaves undeployed ones out', () => {
    expect(appUrls(project())).toEqual({ BACK: 'https://back.example', FRONT: 'https://front.example' });
  });
});

describe('waitForCommit', () => {
  const base = { project: project(), name: 'back', sha: 'new', sleep: noSleep, log: quiet };

  it('passes when the app reports this commit', async () => {
    const { fetchJson } = server({ 'https://back.example/health': ['new'] });
    expect((await waitForCommit({ ...base, fetchJson, git: gitSays(1) })).ok).toBe(true);
  });

  it('passes a skipped build: an older commit whose inputs git says match', async () => {
    const calls: string[][] = [];
    const git: Git = (args) => {
      calls.push(args);
      return { status: 0 };
    };
    const { fetchJson } = server({ 'https://back.example/health': ['old'] });
    const result = await waitForCommit({ ...base, fetchJson, git });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/skipped/);
    // Asked with the ignore step's own pathspecs, so the two cannot disagree.
    expect(calls[0]!.slice(0, 5)).toEqual(['diff', '--quiet', 'old', 'new', '--']);
    expect(calls[0]).toContain('apps/back');
  });

  it('waits through a stale build and a cold start until the new one appears', async () => {
    const { fetchJson, asked } = server({ 'https://back.example/health': ['old', new Error('502'), 'new'] });
    const result = await waitForCommit({ ...base, fetchJson, git: gitSays(1) });
    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(3);
  });

  it('fails at the ceiling rather than waiting forever', async () => {
    const { fetchJson, asked } = server({ 'https://back.example/health': ['old'] });
    const result = await waitForCommit({ ...base, fetchJson, git: gitSays(1), attempts: 3 });
    expect(result.ok).toBe(false);
    expect(asked).toHaveLength(3);
    expect(result.reason).toMatch(/serving an older build/);
  });

  it('declares a ceiling of forty attempts', () => {
    expect(GATE_ATTEMPTS).toBe(40);
  });
});

describe('smoke', () => {
  const answers = () => ({ 'https://back.example/health': ['new'], 'https://front.example/version.json': ['new'] });

  it('gates every deployed app and runs the checks each one owns, with every URL', async () => {
    const ran: [string, Record<string, string>][] = [];
    const { fetchJson, asked } = server(answers());
    const result = await smoke({
      project: project(),
      sha: 'new',
      fetchJson,
      git: gitSays(1),
      sleep: noSleep,
      run: (script, urls) => (ran.push([script, urls]), 0),
      log: quiet,
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual(['https://back.example/health', 'https://front.example/version.json']);
    expect(ran).toEqual([['apps/back/smoke.sh', { BACK: 'https://back.example', FRONT: 'https://front.example' }]]);
  });

  it("stops at the first failure: a failing app's checks end the run", async () => {
    const { fetchJson, asked } = server(answers());
    const result = await smoke({
      project: project(),
      sha: 'new',
      fetchJson,
      git: gitSays(1),
      sleep: noSleep,
      run: () => 1,
      log: quiet,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/apps\/back\/smoke\.sh failed/);
    expect(asked).toEqual(['https://back.example/health']);
  });

  it('does not run an app whose gate failed', async () => {
    let ran = 0;
    const { fetchJson } = server({ 'https://back.example/health': ['old'] });
    const result = await smoke({
      project: project(),
      sha: 'new',
      fetchJson,
      git: gitSays(1),
      sleep: noSleep,
      run: () => (ran++, 0),
      log: quiet,
    });
    expect(result.ok).toBe(false);
    expect(ran).toBe(0);
  });

  it('refuses to run without a commit to check', async () => {
    const { fetchJson } = server(answers());
    const result = await smoke({ project: project(), sha: undefined, fetchJson, git: gitSays(0), sleep: noSleep, run: () => 0, log: quiet });
    expect(result.ok).toBe(false);
  });

  it('passes with nothing deployed, with or without a commit, asking nobody anything', async () => {
    // An engine-only product has no apps at all; an undeployed app has no deploy block. Neither has anything to wait for.
    const engineOnly: Project = { name: 'thing', engine: { commit: 'a'.repeat(40) }, apps: {} };
    const undeployed: Project = { name: 'thing', apps: { tool: project().apps.tool! } };
    for (const p of [engineOnly, undeployed]) {
      for (const [sha, gate] of [[undefined, true], ['new', true], [undefined, false]] as const) {
        const { fetchJson, asked } = server({});
        const result = await smoke({ project: p, sha, gate, fetchJson, git: gitSays(1), sleep: noSleep, run: () => 1, log: quiet });
        expect(result, `${sha} ${gate}`).toEqual({ ok: true, reason: 'nothing is deployed (no app has a deploy block): nothing to check' });
        expect(asked).toEqual([]);
      }
    }
  });

  it('still refuses to gate a deployed app without a commit, though nothing-deployed no longer does', async () => {
    const { fetchJson, asked } = server(answers());
    const result = await smoke({ project: project(), sha: undefined, gate: true, fetchJson, git: gitSays(0), sleep: noSleep, run: () => 0, log: quiet });
    expect(result).toEqual({ ok: false, reason: 'no commit to check: GITHUB_SHA is not set' });
    expect(asked).toEqual([]);
  });

  it('skips the freshness gate when gate is false, checking whatever is currently deployed', async () => {
    const ran: [string, Record<string, string>][] = [];
    // The old commit would fail waitForCommit's gate; gate: false never calls it.
    const { fetchJson, asked } = server({ 'https://back.example/health': ['old'], 'https://front.example/version.json': ['old'] });
    const result = await smoke({
      project: project(),
      sha: undefined,
      gate: false,
      fetchJson,
      git: gitSays(1),
      sleep: noSleep,
      run: (script, urls) => (ran.push([script, urls]), 0),
      log: quiet,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/freshness gate skipped/);
    expect(asked).toEqual(['https://back.example/health', 'https://front.example/version.json']);
    expect(ran).toEqual([['apps/back/smoke.sh', { BACK: 'https://back.example', FRONT: 'https://front.example' }]]);
  });

  it('fails an app whose commit endpoint reports nothing, even with gate: false', async () => {
    const { fetchJson } = server({ 'https://front.example/version.json': ['new'] }); // back answers nothing
    const result = await smoke({
      project: project(),
      sha: undefined,
      gate: false,
      fetchJson,
      git: gitSays(1),
      sleep: noSleep,
      run: () => 0,
      log: quiet,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/back is unreachable/);
  });
});

describe('gateForEvent', () => {
  it('gates every trigger except an explicit schedule or manual dispatch', () => {
    expect(gateForEvent('push')).toBe(true);
    expect(gateForEvent(undefined)).toBe(true);
    expect(gateForEvent('pull_request')).toBe(true);
    expect(gateForEvent('schedule')).toBe(false);
    expect(gateForEvent('workflow_dispatch')).toBe(false);
  });
});

describe("each app's smoke script", () => {
  // The checks are written for a step shell of `bash -e`. Under
  // pipefail, `printf "$page" | grep -q …` fails on a match — grep exits
  // early and printf dies of SIGPIPE — so every retry read "not yet" until the
  // ceiling. Linux delivers that SIGPIPE and Git Bash on Windows does not, so
  // a local run cannot catch it; this does, on every platform.
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  it('runs with the step shell\'s options: set -e, never pipefail', () => {
    // Every app's own smoke script, deployed or not: `verify` keeps an
    // undeployed app's checks around so deploy:add has something to run.
    const scripts = apps(loadProject()).flatMap(([, app]) => (app.smoke ? [app.smoke] : []));
    // An engine-only product has no app and so no script; every other project must have found one.
    if (apps(loadProject()).length > 0) expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const code = readFileSync(join(ROOT, script), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(code, script).toMatch(/^set -e$/m);
      expect(code, script).not.toMatch(/pipefail|set -[a-z]*o /);
    }
  });
});

// Both need apps/web (its smoke.sh and build-docs.mjs), which a product built
// without the web starter does not have (#281).
describe.skipIf(!existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/web/smoke.sh')))("the web app's docs_served check", () => {
  // Run for real: apps/web/smoke.sh against a local server that serves a
  // fresh build of this checkout's docs. The script asks build-docs.mjs which
  // pages that build publishes, so this holds in the base (four pages) and in
  // a product (two) alike, and the failures below are the check doing its job
  // rather than a test computing its own expectation.
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const SCRIPT = join(ROOT, 'apps', 'web', 'smoke.sh');
  const tmp: string[] = [];
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Serves `docs` at /docs/, and the shell bundle the first check looks for.
  async function serve(docs: string, omit: string[] = [], shelled: string[] = []): Promise<string> {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      const reply = (type: string, body: string | Buffer) => (res.writeHead(200, { 'content-type': type }), res.end(body));
      // A host that falls back to the app shell, with a 200, for a file it lacks (vite preview does; a Vercel SPA rewrite would).
      const shell = '<script src="/assets/index-abc123.js"></script>';
      if (path === '/') return reply('text/html', '<script src="/assets/index-abc123.js"></script>');
      if (path === '/assets/index-abc123.js') return reply('text/javascript', 'No application here yet');
      const file = path.replace(/^\/docs\//, '') || 'index.html';
      const name = file === '' ? 'index.html' : file;
      if (path.startsWith('/docs/') && shelled.includes(name)) return reply('text/html', `<!doctype html><title>the app shell</title><div id="root"></div>${shell}`);
      if (path.startsWith('/docs/') && !omit.includes(name) && existsSync(join(docs, name))) {
        return reply('text/html', readFileSync(join(docs, name)));
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function built(): Promise<string> {
    // Resolved at run time, through a variable, so tsc does not look for a file a product without the web starter lacks.
    const buildDocsPath = join(ROOT, 'apps/web/scripts/build-docs.mjs');
    const { buildDocs } = (await import(pathToFileURL(buildDocsPath).href)) as {
      buildDocs: (opts: { root: string; out: string; env: Record<string, string> }) => unknown;
    };
    const out = join(mkdtempSync(join(tmpdir(), 'smoke-docs-')), 'docs');
    tmp.push(dirname(out));
    buildDocs({ root: ROOT, out, env: {} });
    return out;
  }

  const run = (web: string) =>
    new Promise<{ code: number; output: string }>((done) => {
      execFile(
        'bash',
        [SCRIPT],
        { env: { ...process.env, WEB: web, SMOKE_DOCS_ATTEMPTS: '2', SMOKE_DOCS_INTERVAL: '0' }, timeout: 60_000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          done({ code, output: stdout + stderr });
        },
      );
    });

  // Timeout: spawns bash on the smoke script and builds the docs (217 ms quiet); 15 s.
  it('passes against the pages this repository builds, whichever those are', { timeout: 15_000 }, async () => {
    const docs = await built();
    const result = await run(await serve(docs));
    expect(result.output).toContain('every doc page served');
    expect(result.code).toBe(0);
  });

  // Timeout: spawns bash on the smoke script (151 ms quiet); 15 s.
  it('fails when a page the build publishes is not served', { timeout: 15_000 }, async () => {
    const docs = await built();
    const result = await run(await serve(docs, ['sops.html']));
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/missing.*\/docs\/sops\.html/);
  });

  // Timeout: spawns bash on the smoke script (151 ms quiet); 15 s.
  it('fails when a page is served without the heading its source gives it', { timeout: 15_000 }, async () => {
    const docs = await built();
    const page = join(docs, 'sops.html');
    writeFileSync(page, readFileSync(page, 'utf8').replace(/<title>.*<\/title>/, '<title>Something else</title>'));
    const result = await run(await serve(docs));
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/sops\.html did not render its heading/);
  });

  // step-0 exists only where the repository holds a root index.html, the base.
  // Timeout: spawns bash on the smoke script (167 ms quiet); 15 s.
  it.skipIf(!existsSync(join(ROOT, 'index.html')))(
    'fails when step-0.html is the app shell served with a 200, not the page',
    { timeout: 15_000 },
    async () => {
      const docs = await built();
      const result = await run(await serve(docs, [], ['step-0.html']));
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/step-0\.html did not render its heading/);
    },
  );
});
