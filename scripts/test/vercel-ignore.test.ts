import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, forkPoint, type Git } from '../deploy/vercel/vercel-ignore.mjs';
import { buildIsEquivalent } from '../deploy/vercel/smoke.mjs';
import type { Project } from '../project.mjs';

// The layout these tests build in a temporary repository, declared the way
// project.json declares it. A fixture, not the live manifest, so this tests
// the ignore step's decisions whatever the application is.
const FIXTURE: Project = {
  name: 'thing',
  apps: {
    api: {
      path: 'apps/api',
      toolchain: 'python',
      deploy: { provider: 'vercel', team: 't', project: 'thing-api', url: 'https://api.example', commitEndpoint: '/health' },
      reads: ['apps/api'],
    },
    web: {
      path: 'apps/web',
      toolchain: 'node',
      deploy: { provider: 'vercel', team: 't', project: 'thing-web', url: 'https://web.example', commitEndpoint: '/version.json' },
      reads: ['apps/web', 'docs', 'manual/web', 'index.html', 'package.json', 'package-lock.json', 'scripts/markdown.mjs'],
      ignores: ['apps/web/e2e', '**/*.test.ts', '**/*.test.tsx'],
    },
  },
};

const SHA = 'a'.repeat(40);

const manifestText = (project: Project, engine: string) => JSON.stringify({ ...project, engine: { commit: engine } }, null, 2);

// A git stand-in: answers by the first argument, and records every call.
function fakeGit(answers: Record<string, { status: number; stdout?: string }>) {
  const calls: string[][] = [];
  const git: Git = (args) => {
    calls.push(args);
    const answer = answers[args[0] ?? ''] ?? { status: 0 };
    return { status: answer.status, stdout: answer.stdout ?? '' };
  };
  return { git, calls };
}

describe('decide', () => {
  it('skips when the diff since the previous deployment is empty', () => {
    const { git } = fakeGit({ diff: { status: 0 } });
    expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(false);
  });

  it('builds when the diff since the previous deployment is not empty', () => {
    const { git } = fakeGit({ diff: { status: 1 } });
    expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(true);
  });

  it('builds when git diff errors rather than answering', () => {
    const { git } = fakeGit({ diff: { status: 128 } });
    expect(decide('web', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(true);
  });

  it('builds an unknown project without touching git', () => {
    const { git, calls } = fakeGit({});
    expect(decide('not-in-project-json', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(true);
    expect(calls).toEqual([]);
  });

  it('fetches the previous commit when the shallow clone lacks it', () => {
    const { git, calls } = fakeGit({ 'cat-file': { status: 1 }, diff: { status: 0 } });
    expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(false);
    expect(calls).toContainEqual(['fetch', '--no-tags', '--depth=1', '--end-of-options', 'origin', SHA]);
  });

  it('builds when the previous commit cannot be fetched', () => {
    const { git } = fakeGit({ 'cat-file': { status: 1 }, fetch: { status: 128 } });
    expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(true);
  });

  it("compares a branch's first push with where it left develop", () => {
    // The log's first line is HEAD — the branch's own commit — then develop.
    const log = 'b1\tdev123\tme@example.com\tStart\n' + 'dev123\tpar1\tnoreply@github.com\tAdd a thing (#42)\n';
    const { git, calls } = fakeGit({ log: { status: 0, stdout: log }, diff: { status: 0 } });
    expect(decide('web', {}, git, FIXTURE).build).toBe(false);
    expect(calls.find((c) => c[0] === 'diff')?.slice(0, 5)).toEqual(['diff', '--quiet', '--end-of-options', 'dev123', 'HEAD']);
  });

  // A fresh project has no previous production deployment, so
  // VERCEL_GIT_PREVIOUS_SHA is unset, and develop's HEAD is itself a squash
  // merge — "nothing changed since <HEAD>" every time, and production never
  // builds at all.
  it('builds production when there has never been a production deployment', () => {
    const log = 'd3\td2\tnoreply@github.com\tChange the API (#28)\n' + 'd2\td1\tnoreply@github.com\tDocs (#26)\n';
    const { git } = fakeGit({ log: { status: 0, stdout: log }, diff: { status: 0 } });
    const result = decide('api', { VERCEL_ENV: 'production' }, git, FIXTURE);
    expect(result.build).toBe(true);
    expect(result.reason).toMatch(/no previous production deployment/);
  });

  it("builds a branch's first push when no fork point is in the clone", () => {
    const { git } = fakeGit({ log: { status: 0, stdout: SHA + '\tpar\tme@example.com\tWork\n' } });
    expect(decide('web', {}, git, FIXTURE).build).toBe(true);
  });
});

describe('forkPoint', () => {
  const at = (stdout: string) => forkPoint(fakeGit({ log: { status: 0, stdout } }).git);

  it('picks the nearest squash merge, past the branch’s own commits', () => {
    expect(
      at(
        'b2\tb1\tme@example.com\tFix review finding (#7)\n' +
          'b1\td2\tme@example.com\tStart\n' +
          'd2\td1\tnoreply@github.com\tAdd a thing (#42)\n' +
          'd1\td0\tnoreply@github.com\tAdd another (#41)\n',
      ),
    ).toBe('d2');
  });

  it('never takes a GitHub "update branch" merge, which carries the branch’s own changes', () => {
    expect(
      at(
        'm1\tb1 d3\tnoreply@github.com\tMerge branch develop into feat (#9)\n' +
          'b1\td2\tme@example.com\tStart\n' +
          'd2\td1\tnoreply@github.com\tAdd a thing (#42)\n',
      ),
    ).toBe('d2');
  });

  it('never returns HEAD itself, even when HEAD is a squash merge', () => {
    // Comparing HEAD with HEAD is always an empty diff — a skip that proves nothing.
    expect(
      at('d3\td2\tnoreply@github.com\tChange the API (#28)\n' + 'd2\td1\tnoreply@github.com\tDocs (#26)\n'),
    ).toBe('d2');
  });

  it('gives up when git log fails', () => {
    expect(forkPoint(fakeGit({ log: { status: 128 } }).git)).toBeNull();
  });
});

// The pathspecs, against a real repository: which changes each project sees.
describe('pathspecs', () => {
  let repo: string;
  let base: string;

  const git: Git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    return { status: result.status ?? -1, stdout: result.stdout ?? '' };
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = () => {
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c']);
  };
  const touching = (path: string) => {
    write(path, 'changed');
    commit();
    const env = { VERCEL_GIT_PREVIOUS_SHA: base };
    return { api: decide('api', env, git, FIXTURE).build, web: decide('web', env, git, FIXTURE).build };
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vercel-ignore-'));
    git(['init', '-q']);
    write('project.json', manifestText(FIXTURE, 'engine-1'));
    for (const path of ['apps/api/x', 'apps/web/x', 'docs/x', '.claude/x', '.github/x', 'CLAUDE.md', 'scripts/x']) {
      write(path, 'original');
    }
    commit();
    base = git(['rev-parse', 'HEAD']).stdout.trim();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // Timeout: spawns git in a real repository (505 ms quiet); 60 s.
  it('skips both for a change only to agent configuration', { timeout: 60_000 }, () => {
    expect(touching('.claude/x')).toEqual({ api: false, web: false });
    expect(touching('CLAUDE.md')).toEqual({ api: false, web: false });
    expect(touching('.github/x')).toEqual({ api: false, web: false });
  });

  // Timeout: spawns git in a real repository (261 ms quiet); 30 s.
  it('builds only the API for a change under apps/api', { timeout: 30_000 }, () => {
    expect(touching('apps/api/x')).toEqual({ api: true, web: false });
  });

  // Timeout: spawns git in a real repository (284 ms quiet); 30 s.
  it('builds only the web app for docs, which its prebuild renders', { timeout: 30_000 }, () => {
    expect(touching('docs/x')).toEqual({ api: false, web: true });
  });

  // Timeout: spawns git in a real repository (196 ms quiet); 15 s.
  it('builds both when the ignore script itself changes', { timeout: 15_000 }, () => {
    expect(touching('scripts/deploy/vercel/vercel-ignore.mjs')).toEqual({ api: true, web: true });
  });

  // Timeout: spawns git in a real repository (806 ms quiet); 60 s.
  it('skips the web app for tests and CI-only scripts, which never reach the bundle', { timeout: 60_000 }, () => {
    expect(touching('apps/web/src/thing.test.ts')).toEqual({ api: false, web: false });
    expect(touching('apps/web/e2e/docs.spec.ts')).toEqual({ api: false, web: false });
    expect(touching('scripts/pr-contention.mjs')).toEqual({ api: false, web: false });
    expect(touching('scripts/paths.mjs')).toEqual({ api: false, web: false });
    expect(touching('scripts/deploy/vercel/vercel-prune.mjs')).toEqual({ api: false, web: false });
    expect(touching('scripts/triage.mjs')).toEqual({ api: false, web: false });
    expect(touching('scripts/write-ci-sandbox-settings.mjs')).toEqual({ api: false, web: false });
  });

  // Timeout: spawns git in a real repository (327 ms quiet); 30 s.
  it("builds the web app for the scripts its prebuild runs", { timeout: 30_000 }, () => {
    expect(touching('apps/web/scripts/build-docs.mjs')).toEqual({ api: false, web: true });
    expect(touching('scripts/markdown.mjs')).toEqual({ api: false, web: true });
  });

  // Timeout: spawns git in a real repository (239 ms quiet); 15 s.
  it('builds nothing for a path no app declares it reads', { timeout: 15_000 }, () => {
    // The manifest lists what a build reads, not what it does not. A read left
    // undeclared is caught after merge by smoke.yml's freshness gates.
    expect(touching('brand-new/x')).toEqual({ api: false, web: false });
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('rebuilds both when the code that reads the manifest changes', { timeout: 30_000 }, () => {
    expect(touching('scripts/project.mjs')).toEqual({ api: true, web: true });
  });
});

// project.json is not a watched path: only an app's own entry in it decides.
// Each case asks the ignore step and the smoke freshness gate over the same
// real repository, and they must agree.
describe('the manifest', () => {
  let repo: string;
  let base: string;

  const git: Git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    return { status: result.status ?? -1, stdout: result.stdout ?? '' };
  };
  const commitFiles = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c']);
  };
  const edited = (edit: (p: Project) => void, engine = 'engine-1'): string => {
    const copy = JSON.parse(JSON.stringify(FIXTURE)) as Project;
    edit(copy);
    return manifestText(copy, engine);
  };
  // What the ignore step and the smoke gate each say about this change.
  const both = (name: 'api' | 'web') => {
    const ignore = decide(name, { VERCEL_GIT_PREVIOUS_SHA: base }, git, FIXTURE).build;
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const gate = !buildIsEquivalent({ git, project: FIXTURE, name, deployedSha: base, sha: head });
    expect(gate, 'smoke gate and ignore step disagree').toBe(ignore);
    return ignore;
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vercel-ignore-manifest-'));
    git(['init', '-q']);
    commitFiles({ 'project.json': manifestText(FIXTURE, 'engine-1'), 'apps/api/x': 'o', 'apps/web/x': 'o' });
    base = git(['rev-parse', 'HEAD']).stdout.trim();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('skips an app for an engine.commit-only change', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited(() => {}, 'engine-2') });
    expect(both('api')).toBe(false);
    expect(both('web')).toBe(false);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it("builds an app when its own entry changes, and skips the other for it", { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited((p) => p.apps.api!.reads.push('shared')) });
    expect(both('api')).toBe(true);
    expect(both('web')).toBe(false);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('builds an app when a deploy field of its entry changes', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited((p) => { p.apps.web!.deploy!.url = 'https://other.example'; }) });
    expect(both('web')).toBe(true);
    expect(both('api')).toBe(false);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('still builds for a change under the reads, alongside an engine-only manifest change', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited(() => {}, 'engine-2'), 'apps/api/x': 'changed' });
    expect(both('api')).toBe(true);
    expect(both('web')).toBe(false);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('builds for a top-level name change, which the web build reads', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited((p) => { p.name = 'renamed'; }) });
    expect(both('api')).toBe(true);
    expect(both('web')).toBe(true);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('builds for an unknown top-level key, which fails closed', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited((p) => { (p as unknown as Record<string, unknown>).somethingNew = 1; }) });
    expect(both('api')).toBe(true);
    expect(both('web')).toBe(true);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('builds when the base manifest is unparseable', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': '{ not json' });
    base = git(['rev-parse', 'HEAD']).stdout.trim();
    commitFiles({ 'project.json': edited(() => {}, 'engine-2') });
    expect(both('api')).toBe(true);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('builds when the base has no manifest at all', { timeout: 30_000 }, () => {
    git(['rm', '-q', 'project.json']);
    commitFiles({});
    base = git(['rev-parse', 'HEAD']).stdout.trim();
    commitFiles({ 'project.json': edited(() => {}) });
    expect(both('api')).toBe(true);
  });

  // Timeout: spawns git in a real repository; 30 s.
  it('builds when the app is missing from the base manifest', { timeout: 30_000 }, () => {
    commitFiles({ 'project.json': edited((p) => { delete p.apps.api; }) });
    base = git(['rev-parse', 'HEAD']).stdout.trim();
    commitFiles({ 'project.json': edited(() => {}) });
    expect(both('api')).toBe(true);
  });
});

// The same decisions with git stubbed, as the other tests here do.
describe('untrusted previous sha', () => {
  it('builds, running no git command, for a value that is not a commit id', () => {
    for (const value of ['--upload-pack=x', '--output=x', 'abc', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), ' ' + 'a'.repeat(39)]) {
      const { git, calls } = fakeGit({ diff: { status: 0 } });
      const result = decide('api', { VERCEL_GIT_PREVIOUS_SHA: value }, git, FIXTURE);
      expect(result.build, value).toBe(true);
      expect(result.reason, value).toBe('previous deployment sha is not a commit id');
      expect(calls, value).toEqual([]);
    }
  });

  it('puts --end-of-options before the revision in cat-file, fetch and diff', () => {
    const { git, calls } = fakeGit({ 'cat-file': { status: 1 }, fetch: { status: 0 }, diff: { status: 1 } });
    decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE);
    for (const name of ['cat-file', 'fetch', 'diff']) {
      const call = calls.find((c) => c[0] === name);
      expect(call, name).toBeDefined();
      const rev = call!.findIndex((a) => a.startsWith(SHA));
      expect(rev, name).toBeGreaterThan(-1);
      expect(call!.indexOf('--end-of-options'), name).toBeGreaterThan(-1);
      expect(call!.indexOf('--end-of-options'), name).toBeLessThan(rev);
    }
  });

  it('has no cat-file, fetch or diff call in the ignore script without --end-of-options', () => {
    const source = readFileSync(join(__dirname, '../deploy/vercel/vercel-ignore.mjs'), 'utf8');
    const calls = [...source.matchAll(/git\(\[([^\]]*)\]\)/g)].map((m) => m[1]!).filter((a) => /^'(cat-file|fetch|diff)'/.test(a));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toContain("'--end-of-options'");
  });
});

describe('the manifest, with git stubbed', () => {
  const entry = (project: Project) => JSON.stringify({ ...project, engine: { commit: 'x' } });
  const stub = (diffs: { paths: number; manifest: number }, shown: Record<string, string | undefined>) => {
    const git: Git = (args) => {
      if (args[0] === 'diff') return { status: args.includes('project.json') ? diffs.manifest : diffs.paths, stdout: '' };
      if (args[0] === 'show') {
        const text = shown[args[2]!.split(':')[0]!];
        return text === undefined ? { status: 128, stdout: '' } : { status: 0, stdout: text };
      }
      return { status: 0, stdout: '' };
    };
    return git;
  };
  const other = JSON.parse(JSON.stringify(FIXTURE)) as Project;
  other.apps.web!.reads.push('more');

  it('skips when the manifest differs only outside this app, and the smoke gate agrees', () => {
    const git = stub({ paths: 0, manifest: 1 }, { [SHA]: entry(FIXTURE), HEAD: entry(other) });
    expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(false);
    expect(buildIsEquivalent({ git: stub({ paths: 0, manifest: 1 }, { [SHA]: entry(FIXTURE), new: entry(other) }), project: FIXTURE, name: 'api', deployedSha: SHA, sha: 'new' })).toBe(true);
  });

  it('builds when this app’s entry differs, and the smoke gate agrees', () => {
    const git = stub({ paths: 0, manifest: 1 }, { [SHA]: entry(FIXTURE), HEAD: entry(other) });
    expect(decide('web', { VERCEL_GIT_PREVIOUS_SHA: SHA }, git, FIXTURE).build).toBe(true);
    expect(buildIsEquivalent({ git: stub({ paths: 0, manifest: 1 }, { [SHA]: entry(FIXTURE), new: entry(other) }), project: FIXTURE, name: 'web', deployedSha: SHA, sha: 'new' })).toBe(false);
  });

  it('builds when the manifest cannot be read or parsed, in either direction', () => {
    for (const shown of [{ [SHA]: undefined, HEAD: entry(FIXTURE) }, { [SHA]: 'nope', HEAD: entry(FIXTURE) }, { [SHA]: entry(FIXTURE), HEAD: '[' }]) {
      expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, stub({ paths: 0, manifest: 1 }, shown), FIXTURE).build).toBe(true);
    }
  });

  it('builds when the base is a flag-looking value only as a revision, after --end-of-options', () => {
    const seen: string[][] = [];
    const git: Git = (args) => {
      seen.push(args);
      return { status: 1, stdout: '' };
    };
    decide('api', { VERCEL_GIT_PREVIOUS_SHA: '--output=x' }, git, FIXTURE);
    for (const call of seen.filter((c) => c[0] === 'diff')) expect(call.indexOf('--end-of-options')).toBeLessThan(call.indexOf('--output=x'));
  });

  it('builds when diffing the manifest errors', () => {
    expect(decide('api', { VERCEL_GIT_PREVIOUS_SHA: SHA }, stub({ paths: 0, manifest: 128 }, {}), FIXTURE).build).toBe(true);
  });
});
