import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_CODE,
  appFor,
  apps,
  buildPathspecs,
  cli,
  deployed,
  hasDeploy,
  loadProject,
  validate,
  verifiedPaths,
  type Project,
} from '../project.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const minimal = (): Project => ({
  name: 'thing',
  apps: {
    svc: { path: 'apps/svc', toolchain: 'python', reads: ['apps/svc'] },
    ui: {
      path: 'apps/ui',
      toolchain: 'node',
      reads: ['apps/ui', 'docs'],
      ignores: ['apps/ui/e2e', '**/*.test.ts'],
      deploy: { provider: 'vercel', team: 't', project: 'thing-ui', url: 'https://thing.example', commitEndpoint: '/version.json' },
      smoke: 'apps/ui/smoke.sh',
    },
  },
});

describe('the committed project.json', () => {
  it("names smoke scripts that exist, and keeps them out of their app's build inputs", () => {
    const project = loadProject();
    for (const [name, app] of deployed(project)) {
      if (!app.smoke) continue;
      expect(readFileSync(join(REPO_ROOT, app.smoke), 'utf8'), app.smoke).toMatch(/^#!\/usr\/bin\/env bash/);
      // A change to the checks is not a change to the build.
      expect(buildPathspecs(project, name), name).toContain(`:(exclude)${app.smoke}`);
    }
  });

  // Timeout: spawns git ls-files (11 ms quiet); 15 s.
  it('is valid, and every declared app directory exists', { timeout: 15_000 }, () => {
    const project = loadProject();
    for (const [, app] of apps(project)) {
      const listed = execFileSync('git', ['ls-files', '--', app.path], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(listed.length, `${app.path} has tracked files`).toBeGreaterThan(0);
    }
  });

  // Timeout: spawns git ls-files (5 ms quiet); 15 s.
  it('deploys exactly the projects that have vercel.json ignore steps', { timeout: 15_000 }, () => {
    const project = loadProject();
    // Every deployed app has a vercel.json running the ignore step under its name…
    for (const [name, app] of deployed(project)) {
      const vercelJson = readFileSync(join(REPO_ROOT, app.path, 'vercel.json'), 'utf8');
      expect(vercelJson).toContain(`vercel-ignore.mjs ${name}`);
    }
    // …and every tracked vercel.json belongs to a deployed app of that name.
    const tracked = execFileSync('git', ['ls-files', '--', '*vercel.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const deployedPaths = new Map(deployed(project).map(([name, app]) => [`${app.path}/vercel.json`, name]));
    expect(tracked.sort()).toEqual([...deployedPaths.keys()].sort());
    for (const file of tracked) {
      const { ignoreCommand } = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as { ignoreCommand: string };
      expect(ignoreCommand.endsWith(` ${deployedPaths.get(file)}`), file).toBe(true);
    }
  });

  it('deploys nothing by default: an app with no deploy block is not deployed', () => {
    const undeployed = { name: 'thing', apps: { svc: minimal().apps.svc! } };
    expect(deployed(validate(undeployed))).toEqual([]);
    expect(hasDeploy(validate(undeployed))).toBe(false);
    expect(hasDeploy(minimal())).toBe(true);
  });
});

describe('the --has-deploy CLI', () => {
  // Each case runs a copy of project.mjs beside a project.json written for it, so the
  // answer does not depend on whether the repository running the tests deploys anything.
  const runIn = (manifest: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'has-deploy-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(join(REPO_ROOT, 'scripts/project.mjs'), join(dir, 'scripts/project.mjs'));
      writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest));
      return spawnSync('node', ['scripts/project.mjs', '--has-deploy'], { cwd: dir, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const app = { path: 'apps/svc', toolchain: 'python', reads: ['apps/svc'] };

  // Timeout: spawns node scripts/project.mjs (35 ms quiet); 15 s.
  it('prints false and exits non-zero against a project.json that deploys nothing', { timeout: 15_000 }, () => {
    const result = runIn({ name: 'thing', apps: { svc: app } });
    expect(result.stdout.trim()).toBe('false');
    expect(result.status).toBe(1);
  });

  it('prints true and exits zero once an app has a deploy block', { timeout: 15_000 }, () => {
    const deploy = { provider: 'vercel', team: 't', project: 'p', url: 'https://p.example', commitEndpoint: '/health' };
    const result = runIn({ name: 'thing', apps: { svc: { ...app, deploy } } });
    expect(result.stdout.trim()).toBe('true');
    expect(result.status).toBe(0);
  });

  it('agrees with the committed project.json, whichever state it is in', { timeout: 15_000 }, () => {
    const result = spawnSync('node', ['scripts/project.mjs', '--has-deploy'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.stdout.trim()).toBe(String(hasDeploy(loadProject())));
    expect(result.status).toBe(hasDeploy(loadProject()) ? 0 : 1);
  });
});

describe('validate', () => {
  it('accepts the documented shape', () => {
    expect(validate(minimal()).name).toBe('thing');
  });

  it('accepts services: ["postgres"] and an empty list', () => {
    const ok = minimal();
    ok.apps.svc!.services = ['postgres'];
    expect(validate(ok).apps.svc!.services).toEqual(['postgres']);
    ok.apps.svc!.services = [];
    expect(() => validate(ok)).not.toThrow();
  });

  it('refuses an unknown service, and services that is not a list', () => {
    const unknown = minimal();
    (unknown.apps.svc as { services: string[] }).services = ['postgres', 'redis'];
    expect(() => validate(unknown)).toThrow(/apps\.svc\.services.*redis/);
    const notList = minimal();
    (notList.apps.svc as { services: unknown }).services = 'postgres';
    expect(() => validate(notList)).toThrow(/apps\.svc\.services must be a list/);
  });

  it('names the field that is wrong', () => {
    const badToolchain = minimal();
    (badToolchain.apps.svc as { toolchain: string }).toolchain = 'ruby';
    expect(() => validate(badToolchain)).toThrow(/apps\.svc\.toolchain/);
    const absolute = minimal();
    absolute.apps.svc!.path = '/etc';
    expect(() => validate(absolute)).toThrow(/apps\.svc\.path/);
  });

  it('accepts an optional engine.commit, and a project without one', () => {
    const sha = 'a'.repeat(39) + '1';
    expect(validate({ ...minimal(), engine: { commit: sha } }).engine?.commit).toBe(sha);
    expect(validate(minimal()).engine).toBeUndefined();
  });

  it('refuses an engine.commit that is not a full lowercase 40-hex SHA, naming the field', () => {
    for (const commit of ['abc1234', 'A'.repeat(40), 'g'.repeat(40), `${'a'.repeat(40)}0`, '', 7, null]) {
      const bad = { ...minimal(), engine: { commit } } as unknown as Project;
      expect(() => validate(bad), String(commit)).toThrow(/"engine\.commit" must be a full 40-character/);
    }
    for (const engine of ['abc', null, [], {}]) {
      const bad = { ...minimal(), engine } as unknown as Project;
      expect(() => validate(bad), JSON.stringify(engine)).toThrow(/"engine/);
    }
  });

  it('refuses an app with no deploy block at all: verify still runs it, nothing deploy-related touches it', () => {
    expect(() => validate(minimal())).not.toThrow();
    expect(deployed(minimal())).toEqual([['ui', minimal().apps.ui]]);
    expect(deployed(minimal()).some(([name]) => name === 'svc')).toBe(false);
  });

  it('refuses an unknown deploy provider', () => {
    const unknown = minimal();
    unknown.apps.ui!.deploy!.provider = 'nope';
    expect(() => validate(unknown)).toThrow(/apps\.ui\.deploy\.provider must be one of/);
  });

  it('refuses a deploy block that is not an object', () => {
    const stray = minimal();
    (stray.apps.svc as { deploy?: unknown }).deploy = 'vercel';
    expect(() => validate(stray)).toThrow(/apps\.svc\.deploy must be an object/);
  });

  it('refuses an empty Vercel project name or team', () => {
    const emptyProject = minimal();
    emptyProject.apps.ui!.deploy!.project = '';
    expect(() => validate(emptyProject)).toThrow(/apps\.ui\.deploy\.project/);
    const emptyTeam = minimal();
    emptyTeam.apps.ui!.deploy!.team = '';
    expect(() => validate(emptyTeam)).toThrow(/apps\.ui\.deploy\.team/);
  });

  it('requires a deployed app to say where it answers and how it reports its commit', () => {
    const noUrl = minimal();
    delete (noUrl.apps.ui!.deploy as { url?: string }).url;
    expect(() => validate(noUrl)).toThrow(/apps\.ui\.deploy\.url/);
    const withPath = minimal();
    withPath.apps.ui!.deploy!.url = 'https://thing.example/app';
    expect(() => validate(withPath)).toThrow(/https origin with no path/);
    const plain = minimal();
    plain.apps.ui!.deploy!.url = 'http://thing.example';
    expect(() => validate(plain)).toThrow(/apps\.ui\.deploy\.url/);
    const relative = minimal();
    relative.apps.ui!.deploy!.commitEndpoint = 'version.json';
    expect(() => validate(relative)).toThrow(/apps\.ui\.deploy\.commitEndpoint/);
  });

  it('accepts sha256 templateHashes on a deploy block and rejects malformed ones', () => {
    const ok = minimal();
    ok.apps.ui!.deploy!.templateHashes = { vercelJson: 'a'.repeat(64) };
    expect(() => validate(ok)).not.toThrow();
    ok.apps.ui!.deploy!.templateHashes = { vercelJson: 'nope' };
    expect(() => validate(ok)).toThrow(/templateHashes\.vercelJson/);
  });

  it('rejects a templateHashes key deploy:add does not write, naming it', () => {
    const typo = minimal();
    typo.apps.ui!.deploy!.templateHashes = { vercelJSON: 'a'.repeat(64) } as never;
    expect(() => validate(typo)).toThrow(/templateHashes\.vercelJSON/);
  });

  it('accepts both known templateHashes keys together', () => {
    const ok = minimal();
    ok.apps.ui!.deploy!.templateHashes = { vercelJson: 'a'.repeat(64), skill: 'b'.repeat(64) };
    expect(() => validate(ok)).not.toThrow();
  });

  it("keeps an app's smoke script inside that app, however the path is spelled", () => {
    for (const smoke of [
      'scripts/evil.sh',
      'apps/ui/../../etc/passwd',
      'apps/ui/../other/smoke.sh',
      'apps/ui/./smoke.sh',
      'apps/ui',
      '/apps/ui/smoke.sh',
      'apps/uix/smoke.sh',
    ]) {
      const outside = minimal();
      outside.apps.ui!.smoke = smoke;
      expect(() => validate(outside), smoke).toThrow(/apps\.ui\.smoke/);
    }
    const nested = minimal();
    nested.apps.ui!.smoke = 'apps/ui/checks/smoke.sh';
    expect(() => validate(nested)).not.toThrow();
  });

  it('refuses an app path that climbs out of the repository', () => {
    for (const path of ['../elsewhere', 'apps/../..', 'apps/./svc']) {
      const climbing = minimal();
      climbing.apps.svc!.path = path;
      expect(() => validate(climbing), path).toThrow(/apps\.svc\.path/);
    }
  });

  it('refuses a verify list that is not a list of commands', () => {
    for (const verify of ['npm test', [], [''], ['  '], [42]]) {
      const bad = minimal();
      (bad.apps.svc as { verify: unknown }).verify = verify;
      if (Array.isArray(verify) && verify.length === 0) continue; // an empty list is allowed: nothing to run
      expect(() => validate(bad), JSON.stringify(verify)).toThrow(/apps\.svc\.verify/);
    }
  });

  it('refuses a project with no apps, unless it is a product (it records engine.commit)', () => {
    expect(() => validate({ ...minimal(), apps: {} })).toThrow(/at least one app/);
    const sha = 'a'.repeat(40);
    const engineOnly = validate({ name: 'thing', engine: { commit: sha }, apps: {} });
    expect(engineOnly.apps).toEqual({});
    expect(apps(engineOnly)).toEqual([]);
    expect(deployed(engineOnly)).toEqual([]);
    expect(hasDeploy(engineOnly)).toBe(false);
    expect(verifiedPaths(engineOnly)).toEqual(HARNESS_CODE);
    expect(appFor(engineOnly, 'apps/svc/x.py')).toBeNull();
    expect(cli(['apps'], engineOnly)).toEqual([]);
  });

  it('still refuses a missing or non-object "apps", even in a product', () => {
    const engine = { commit: 'a'.repeat(40) };
    for (const bad of [undefined, null, [], 'api']) {
      expect(() => validate({ name: 'thing', engine, apps: bad }), JSON.stringify(bad)).toThrow(/"apps" must be an object/);
    }
    expect(() => validate({ name: 'thing', engine })).toThrow(/"apps" must be an object/);
  });
});

describe('appFor', () => {
  it('finds the app holding a path, deepest first, and nothing outside every app', () => {
    const project = minimal();
    project.apps.nested = { path: 'apps/svc/plugin', toolchain: 'node', reads: ['apps/svc/plugin'] };
    expect(appFor(project, 'apps/svc/src/x.py')?.[0]).toBe('svc');
    expect(appFor(project, 'apps/svc/plugin/y.ts')?.[0]).toBe('nested');
    expect(appFor(project, 'apps\\svc\\src\\x.py')?.[0]).toBe('svc');
    expect(appFor(project, 'apps/svcx/z.py')).toBeNull();
    expect(appFor(project, 'scripts/a.mjs')).toBeNull();
  });
});

describe('buildPathspecs', () => {
  it("is the app's reads, the manifest and its provider's ignore script, minus its ignores", () => {
    expect(buildPathspecs(minimal(), 'ui')).toEqual([
      'apps/ui',
      'docs',
      'project.json',
      'scripts/project.mjs',
      'scripts/deploy/vercel/vercel-ignore.mjs',
      ':(exclude)apps/ui/e2e',
      ':(exclude,glob)**/*.test.ts',
    ]);
  });

  it('excludes the ignore script for an app with no deploy block: there is no ignore step to be wrong about', () => {
    expect(buildPathspecs(minimal(), 'svc')).toEqual(['apps/svc', 'project.json', 'scripts/project.mjs']);
  });

  it('is null for an app that is not declared', () => {
    expect(buildPathspecs(minimal(), 'nope')).toBeNull();
  });
});

describe('verifiedPaths', () => {
  it("covers every app and every read, plus the AI layer's own code", () => {
    const paths = verifiedPaths(minimal());
    for (const p of ['apps/svc', 'apps/ui', 'docs', ...HARNESS_CODE]) expect(paths).toContain(p);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('covers everything inside every declared app', () => {
    // A hard-coded path here would silently stop covering data-only edits the
    // moment an app moved its data directory. Every app's whole directory is
    // covered instead, whatever the apps are.
    const project = loadProject();
    const covered = verifiedPaths(project);
    for (const [name, app] of apps(project)) {
      expect(covered.some((p) => `${app.path}/data/anything.json`.startsWith(`${p}/`)), name).toBe(true);
    }
  });
});

describe('cli', () => {
  it('lists app paths, optionally for one toolchain', () => {
    expect(cli(['apps'], minimal())).toEqual(['apps/svc', 'apps/ui']);
    expect(cli(['apps', 'python'], minimal())).toEqual(['apps/svc']);
    expect(cli(['apps', 'node'], minimal())).toEqual(['apps/ui']);
  });

  it('says, per toolchain, whether any app uses it, as lines $GITHUB_OUTPUT takes as they are', () => {
    expect(cli(['toolchains'], minimal())).toEqual(['node=true', 'python=true', 'e2e=false', 'postgres=false']);
    const { svc, ui } = minimal().apps;
    expect(cli(['toolchains'], { ...minimal(), apps: { svc: svc! } })).toEqual(['node=false', 'python=true', 'e2e=false', 'postgres=false']);
    expect(cli(['toolchains'], { ...minimal(), apps: { ui: ui! } })).toEqual(['node=true', 'python=false', 'e2e=false', 'postgres=false']);
  });

  it('says e2e=true when an app verifies with an e2e command, and false for a node app that does not', () => {
    const { ui } = minimal().apps;
    const withVerify = (verify: string[]): Project => ({ ...minimal(), apps: { ui: { ...ui!, verify } } });
    expect(cli(['toolchains'], withVerify(['npm run test', 'npm run e2e']))).toEqual(['node=true', 'python=false', 'e2e=true', 'postgres=false']);
    expect(cli(['toolchains'], withVerify(['npm run test', 'npm run build']))).toEqual(['node=true', 'python=false', 'e2e=false', 'postgres=false']);
    // A word match, not a substring: a script that merely contains the letters is not an e2e run.
    expect(cli(['toolchains'], withVerify(['npm run fe2esque']))).toContain('e2e=false');
    expect(cli(['toolchains'], withVerify(['npm run e2esque']))).toContain('e2e=false');
    expect(cli(['toolchains'], withVerify(['playwright test e2e/']))).toContain('e2e=true');
    // `_` is a boundary, and playwright counts as well as e2e.
    for (const command of ['npx playwright test', 'npm run test_e2e', 'uv run pytest tests/test_e2e.py', 'uv run pytest tests/e2e', 'e2e']) {
      expect(cli(['toolchains'], withVerify([command])), command).toContain('e2e=true');
    }
  });

  // catalogue.json is in the base only; a product holds what it was assembled with.
  it.skipIf(!existsSync(join(REPO_ROOT, 'catalogue.json')))('says e2e=true for the base itself, whose web app verifies with npm run e2e', () => {
    expect(cli(['toolchains'], loadProject())).toEqual(['node=true', 'python=true', 'e2e=true', 'postgres=false']);
  });

  it('says false for all of them in an engine-only product, which has no app at all', () => {
    const engineOnly = validate({ name: 'thing', engine: { commit: 'a'.repeat(40) }, apps: {} });
    expect(cli(['toolchains'], engineOnly)).toEqual(['node=false', 'python=false', 'e2e=false', 'postgres=false']);
  });

  it('says postgres=true when any app declares the postgres service', () => {
    const withPg = minimal();
    withPg.apps.svc!.services = ['postgres'];
    expect(cli(['toolchains'], withPg)).toEqual(['node=true', 'python=true', 'e2e=false', 'postgres=true']);
    expect(cli(['toolchains'], minimal())).toContain('postgres=false');
  });

  it('refuses a subcommand it does not have', () => {
    expect(() => cli(['get', 'ui', 'url'], minimal())).toThrow(/usage/);
  });
});

describe('the AI layer names no application', () => {
  it('has no app path, project name or hostname in the code this issue moved behind the manifest', () => {
    const files = [
      'scripts/deploy/vercel/vercel-ignore.mjs',
      'scripts/deploy/vercel/vercel-prune.mjs',
      'scripts/bootstrap.mjs',
      'scripts/smoke.mjs',
      '.github/workflows/smoke.yml',
      '.claude/hooks/verify-on-stop.mjs',
      '.claude/hooks/format-edited.mjs',
      '.github/workflows/verify.yml',
      '.github/workflows/telegram-notify.yml',
    ];
    const project = loadProject();
    const names = [
      project.name,
      ...apps(project).flatMap(([, app]) => [app.path, app.deploy?.team, app.deploy?.project, app.deploy?.url].filter(Boolean)),
      'vercel.app',
    ] as string[];
    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      const code = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|#|\*)/.test(line))
        .join('\n');
      for (const name of names) expect(code, `${file} names ${name}`).not.toContain(name);
    }
  });
});
