import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMOKE_SCHEDULE, SMOKE_EVERY_HOURS, smokeScheduleMessage, addDeploy, ownerSteps, parseArgs, renderTemplate, withPlaceholders, withSmokeSchedule, smokeScheduleProblem } from '../deploy/add.mjs';
import { TEMPLATE_HASH_KEYS, hasDeploy, loadProject, type Project } from '../project.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SMOKE = '.github/workflows/smoke.yml';
const committedSmoke = () => readFileSync(join(REPO_ROOT, SMOKE), 'utf8');
/**
 * The workflow as the engine ships it, whatever state this repository is in:
 * the committed file with the schedule `deploy:add` inserts taken back out.
 * A repository built from this one that has run deploy:add commits the
 * schedule, so tests that need "a workflow with no schedule" as sample input
 * must not read the committed file as if it were that.
 */
const realSmoke = () => committedSmoke().replace(SMOKE_SCHEDULE, '');
/** Top-level `schedule:` trigger lines: two-space indent, so a comment or a nested key never counts. */
const scheduleLines = (text: string) => text.split('\n').filter((line) => /^ {2}schedule:/.test(line));

describe('parseArgs', () => {
  it('parses the provider, --app and the optional flags', () => {
    expect(
      parseArgs(['vercel', '--app', 'api', '--team', 't', '--project', 'p', '--url', 'https://x.example', '--commit-endpoint', '/health']),
    ).toEqual({ provider: 'vercel', app: 'api', team: 't', project: 'p', url: 'https://x.example', commitEndpoint: '/health' });
  });

  it('requires a provider', () => {
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it('requires --app', () => {
    expect(() => parseArgs(['vercel'])).toThrow(/--app/);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseArgs(['vercel', '--app', 'api', '--nope', 'x'])).toThrow(/unknown flag/);
  });

  it('accepts --overwrite as a switch with no value, anywhere among the flags', () => {
    expect(parseArgs(['vercel', '--app', 'api', '--overwrite'])).toEqual({ provider: 'vercel', app: 'api', overwrite: true });
    expect(parseArgs(['vercel', '--overwrite', '--app', 'api', '--team', 't'])).toEqual({ provider: 'vercel', app: 'api', team: 't', overwrite: true });
  });

  it('leaves overwrite unset by default', () => {
    expect(parseArgs(['vercel', '--app', 'api']).overwrite).toBeUndefined();
  });

  it('refuses a flag with no value', () => {
    expect(() => parseArgs(['vercel', '--app'])).toThrow(/needs a value/);
  });
});

describe('withPlaceholders', () => {
  it('fills in whatever is missing with an obvious placeholder, never a guess', () => {
    expect(withPlaceholders({})).toEqual({
      team: '<team>',
      project: '<project>',
      url: 'https://<project>.vercel.app',
      commitEndpoint: '/health',
    });
  });

  it('keeps whatever is given', () => {
    expect(withPlaceholders({ team: 't', project: 'p', url: 'https://p.example', commitEndpoint: '/h' })).toEqual({
      team: 't',
      project: 'p',
      url: 'https://p.example',
      commitEndpoint: '/h',
    });
  });

  it('falls back to the existing values before reaching for a placeholder', () => {
    const existing = { team: 't', project: 'p', url: 'https://p.example', commitEndpoint: '/h' };
    expect(withPlaceholders({ commitEndpoint: '/health', existing })).toEqual({
      team: 't',
      project: 'p',
      url: 'https://p.example',
      commitEndpoint: '/health',
    });
  });

  it('still falls back to a placeholder when existing has nothing for that key', () => {
    expect(withPlaceholders({ team: 't', existing: {} })).toEqual({
      team: 't',
      project: '<project>',
      url: 'https://<project>.vercel.app',
      commitEndpoint: '/health',
    });
  });
});

describe('renderTemplate', () => {
  it('replaces every <key> with its value', () => {
    expect(renderTemplate('node x.mjs <app> for <team>/<project>', { app: 'api', team: 't', project: 'p' })).toBe('node x.mjs api for t/p');
  });
});

describe('ownerSteps', () => {
  it("names the app's Root Directory, and the VERCEL_TOKEN step", () => {
    const steps = ownerSteps({ app: 'api', team: 't', project: 'p' });
    expect(steps.some((s) => s.includes('apps/api'))).toBe(true);
    expect(steps.some((s) => s.includes('VERCEL_TOKEN'))).toBe(true);
    expect(steps.some((s) => s.includes('data-governance.md'))).toBe(true);
  });

  it('says to set Production Branch to main', () => {
    expect(ownerSteps({ app: 'api', team: 't', project: 'p' }).some((s) => s.includes('Set Production Branch to `main`'))).toBe(true);
  });
});

describe('addDeploy', () => {
  let root: string;
  let manifestPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deploy-add-'));
    mkdirSync(join(root, 'apps/api'), { recursive: true });
    manifestPath = join(root, 'project.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'thing', apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] } } }, null, 2),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records a template hash for exactly the keys project.mjs allows', () => {
    addDeploy({ provider: 'vercel', app: 'api', team: 't', project: 'thing-api', url: 'https://thing-api.example', commitEndpoint: '/health', root, manifestPath });
    const hashes = JSON.parse(readFileSync(manifestPath, 'utf8')).apps.api.deploy.templateHashes;
    // A literal, not TEMPLATE_HASH_KEYS: add.mjs builds its kinds from that constant, so comparing
    // against it can never fail. Adding a key must force a deliberate edit here.
    expect(Object.keys(hashes).sort()).toEqual(['skill', 'vercelJson']);
  });

  it('allows exactly the template hash keys skill and vercelJson', () => {
    expect([...TEMPLATE_HASH_KEYS].sort()).toEqual(['skill', 'vercelJson']);
  });

  it('writes the deploy block, vercel.json and the deployment skill, filling in placeholders', () => {
    const { values } = addDeploy({
      provider: 'vercel',
      app: 'api',
      team: 't',
      project: 'thing-api',
      url: 'https://thing-api.example',
      commitEndpoint: '/health',
      root,
      manifestPath,
    });
    expect(values).toEqual({ team: 't', project: 'thing-api', url: 'https://thing-api.example', commitEndpoint: '/health' });

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.apps.api.deploy).toEqual({
      provider: 'vercel',
      team: 't',
      project: 'thing-api',
      url: 'https://thing-api.example',
      commitEndpoint: '/health',
      templateHashes: { vercelJson: expect.stringMatching(/^[0-9a-f]{64}$/), skill: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });

    const vercelJson = readFileSync(join(root, 'apps/api/vercel.json'), 'utf8');
    expect(vercelJson).toContain('vercel-ignore.mjs api');
    expect(vercelJson).not.toContain('<app>');

    const skill = readFileSync(join(root, 'apps/api/.claude/skills/deployment/SKILL.md'), 'utf8');
    expect(skill).toContain('thing-api');
    expect(skill).not.toContain('<project>');
    expect(skill).not.toContain('<app>');
  });

  it("puts the skill inside the app it is about, one per app, and writes none under apps/ itself", () => {
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.apps.web = { path: 'apps/web', toolchain: 'node', reads: ['apps/web'] };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    addDeploy({ provider: 'vercel', app: 'api', project: 'thing-api', root, manifestPath });
    addDeploy({ provider: 'vercel', app: 'web', project: 'thing-web', root, manifestPath });

    expect(readFileSync(join(root, 'apps/api/.claude/skills/deployment/SKILL.md'), 'utf8')).toContain('thing-api');
    expect(readFileSync(join(root, 'apps/web/.claude/skills/deployment/SKILL.md'), 'utf8')).toContain('thing-web');
    expect(existsSync(join(root, 'apps/.claude'))).toBe(false);
  });

  it('fills in obvious placeholders, never a guess at the real values, when flags are left out', () => {
    const { values } = addDeploy({ provider: 'vercel', app: 'api', root, manifestPath });
    expect(values.team).toBe('<team>');
    expect(values.url).toBe('https://<project>.vercel.app');
  });

  it('a re-run rewrites the deploy block but keeps an unchanged vercel.json', () => {
    addDeploy({ provider: 'vercel', app: 'api', team: 't', project: 'p1', url: 'https://p1.example', commitEndpoint: '/health', root, manifestPath });
    const firstVercelJson = readFileSync(join(root, 'apps/api/vercel.json'), 'utf8');
    const again = addDeploy({ provider: 'vercel', app: 'api', team: 't', project: 'p2', url: 'https://p2.example', commitEndpoint: '/health', root, manifestPath });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.apps.api.deploy.project).toBe('p2');
    expect(again.files).toEqual({ vercelJson: 'kept', skill: 'kept' });
    expect(readFileSync(join(root, 'apps/api/vercel.json'), 'utf8')).toBe(firstVercelJson);
    expect(again.changed).toEqual({
      project: { from: 'p1', to: 'p2' },
      url: { from: 'https://p1.example', to: 'https://p2.example' },
    });
  });

  it('an unchanged re-run reports no changed values', () => {
    const args = { provider: 'vercel', app: 'api', team: 't', project: 'p', url: 'https://p.example', commitEndpoint: '/health', root, manifestPath };
    expect(addDeploy(args).changed).toEqual({});
    expect(addDeploy(args).changed).toEqual({});
    expect(addDeploy({ provider: 'vercel', app: 'api', root, manifestPath }).changed).toEqual({});
  });

  describe('app files that a product may have customised', () => {
    const vercelPath = () => join(root, 'apps/api/vercel.json');
    const skillPath = () => join(root, 'apps/api/.claude/skills/deployment/SKILL.md');
    const customVercel = '{ "rewrites": [{ "source": "/api/:path*", "destination": "/x" }] }\n';
    const customSkill = '# my own deployment notes\n';
    const customise = () => {
      mkdirSync(dirname(skillPath()), { recursive: true });
      writeFileSync(vercelPath(), customVercel);
      writeFileSync(skillPath(), customSkill);
    };

    it('leaves a customised vercel.json byte for byte on a re-run', () => {
      customise();
      const { files } = addDeploy({ provider: 'vercel', app: 'api', project: 'p', root, manifestPath });
      expect(readFileSync(vercelPath(), 'utf8')).toBe(customVercel);
      expect(files.vercelJson).toBe('kept');
    });

    it('leaves an existing deployment skill byte for byte on a re-run', () => {
      customise();
      const { files } = addDeploy({ provider: 'vercel', app: 'api', project: 'p', root, manifestPath });
      expect(readFileSync(skillPath(), 'utf8')).toBe(customSkill);
      expect(files.skill).toBe('kept');
    });

    const hashes = () => JSON.parse(readFileSync(manifestPath, 'utf8')).apps.api.deploy.templateHashes;
    // A getter-style helper: root and manifestPath are assigned in beforeEach, after describe runs.
    const base = () => ({ provider: 'vercel', app: 'api', project: 'p', root, manifestPath });
    const dropHashes = () => {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      delete m.apps.api.deploy.templateHashes;
      writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    };
    /** Make the recorded hash of one file say the template was different when it was written. */
    const ageRecord = (kind: string) => {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      m.apps.api.deploy.templateHashes[kind] = 'f'.repeat(64);
      writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    };

    it('records a sha256 of each template on the first run', () => {
      addDeploy(base());
      expect(hashes().vercelJson).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes().skill).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reports no drift for a kept file identical to what the template renders', () => {
      addDeploy(base());
      const again = addDeploy(base());
      expect(again.files).toEqual({ vercelJson: 'kept', skill: 'kept' });
      expect(again.templateDrift).toEqual({});
    });

    it('calls a kept file that differs while the template is unchanged "customised", and leaves it byte for byte', () => {
      addDeploy(base());
      customise();
      const { templateDrift } = addDeploy(base());
      expect(templateDrift).toEqual({ vercelJson: 'customised', skill: 'customised' });
      expect(readFileSync(vercelPath(), 'utf8')).toBe(customVercel);
      expect(readFileSync(skillPath(), 'utf8')).toBe(customSkill);
    });

    it('reports "template-moved" when the template changed since the file was written, hand-edited or not', () => {
      addDeploy(base());
      ageRecord('vercelJson');
      const stale = readFileSync(vercelPath(), 'utf8').replace('vercel-ignore.mjs', 'vercel-ignore-old.mjs');
      writeFileSync(vercelPath(), stale);
      expect(addDeploy(base()).templateDrift).toEqual({ vercelJson: 'template-moved' });
      expect(readFileSync(vercelPath(), 'utf8')).toBe(stale);
      // A hand-customised file is told the same when the template has moved.
      writeFileSync(vercelPath(), customVercel);
      expect(addDeploy(base()).templateDrift).toEqual({ vercelJson: 'template-moved' });
      expect(readFileSync(vercelPath(), 'utf8')).toBe(customVercel);
    });

    it('says the drift is "unknown" for a deploy block with no recorded hashes, without failing', () => {
      customise();
      const first = addDeploy(base()); // files existed, so nothing was written and nothing recorded
      expect(first.templateDrift).toEqual({ vercelJson: 'unknown', skill: 'unknown' });
      expect(hashes()).toBeUndefined();
      addDeploy({ ...base(), overwrite: true });
      dropHashes();
      writeFileSync(vercelPath(), customVercel);
      expect(addDeploy(base()).templateDrift.vercelJson).toBe('unknown');
    });

    it('--overwrite replaces the file and updates the recorded hashes', () => {
      addDeploy(base());
      ageRecord('vercelJson');
      ageRecord('skill');
      writeFileSync(vercelPath(), customVercel);
      const fixed = addDeploy({ ...base(), overwrite: true });
      expect(fixed.files).toEqual({ vercelJson: 'written', skill: 'written' });
      expect(fixed.templateDrift).toEqual({});
      expect(hashes().vercelJson).not.toBe('f'.repeat(64));
      expect(hashes().skill).not.toBe('f'.repeat(64));
      expect(addDeploy(base()).templateDrift).toEqual({});
    });

    it('refreshes the hash of a kept file that matches the render, so a later edit is "customised"', () => {
      addDeploy(base());
      ageRecord('vercelJson'); // the file is in step with the template, but the record says otherwise
      const synced = readFileSync(vercelPath(), 'utf8');
      expect(addDeploy(base()).templateDrift).toEqual({});
      expect(readFileSync(vercelPath(), 'utf8')).toBe(synced);
      expect(hashes().vercelJson).not.toBe('f'.repeat(64));
      writeFileSync(vercelPath(), customVercel);
      expect(addDeploy(base()).templateDrift).toEqual({ vercelJson: 'customised' });
    });

    it('records a hash for an unknown block whose kept file matches the render', () => {
      addDeploy(base());
      dropHashes();
      expect(addDeploy(base()).templateDrift).toEqual({});
      expect(hashes().vercelJson).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes().skill).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(vercelPath(), customVercel);
      expect(addDeploy(base()).templateDrift).toEqual({ vercelJson: 'customised' });
    });

    it('a kept file that differs from the render does not refresh its recorded hash', () => {
      addDeploy(base());
      ageRecord('vercelJson');
      writeFileSync(vercelPath(), customVercel);
      addDeploy(base());
      expect(hashes().vercelJson).toBe('f'.repeat(64));
    });

    it('still creates a missing file from the template, keeping the other', () => {
      mkdirSync(dirname(vercelPath()), { recursive: true });
      writeFileSync(vercelPath(), customVercel);
      const { files } = addDeploy({ provider: 'vercel', app: 'api', project: 'thing-api', root, manifestPath });
      expect(files).toEqual({ vercelJson: 'kept', skill: 'written' });
      expect(readFileSync(vercelPath(), 'utf8')).toBe(customVercel);
      expect(readFileSync(skillPath(), 'utf8')).toContain('thing-api');
    });

    it('--overwrite replaces both from the template', () => {
      customise();
      const { files } = addDeploy({ provider: 'vercel', app: 'api', project: 'thing-api', overwrite: true, root, manifestPath });
      expect(files).toEqual({ vercelJson: 'written', skill: 'written' });
      expect(readFileSync(vercelPath(), 'utf8')).toContain('vercel-ignore.mjs api');
      expect(readFileSync(vercelPath(), 'utf8')).not.toContain('/api/:path*');
      expect(readFileSync(skillPath(), 'utf8')).toContain('thing-api');
    });
  });

  it('a partial re-run keeps the real values it was not given, and only updates the flag it was', () => {
    addDeploy({
      provider: 'vercel',
      app: 'api',
      team: 'real-team',
      project: 'real-project',
      url: 'https://real-project.example',
      commitEndpoint: '/old-health',
      root,
      manifestPath,
    });

    const { values } = addDeploy({ provider: 'vercel', app: 'api', commitEndpoint: '/health', root, manifestPath });

    expect(values).toEqual({
      team: 'real-team',
      project: 'real-project',
      url: 'https://real-project.example',
      commitEndpoint: '/health',
    });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.apps.api.deploy).toEqual({
      provider: 'vercel',
      team: 'real-team',
      project: 'real-project',
      url: 'https://real-project.example',
      commitEndpoint: '/health',
      templateHashes: { vercelJson: expect.stringMatching(/^[0-9a-f]{64}$/), skill: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  it('refuses an app project.json does not declare, before writing anything', () => {
    expect(() => addDeploy({ provider: 'vercel', app: 'nope', root, manifestPath })).toThrow(/no app named "nope"/);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.apps.api.deploy).toBeUndefined();
  });

  it('refuses a provider nothing registers, before writing anything', () => {
    expect(() => addDeploy({ provider: 'nope', app: 'api', root, manifestPath })).toThrow(/unknown deploy provider "nope"/);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.apps.api.deploy).toBeUndefined();
  });
});

describe('the scheduled smoke run (#254)', () => {
  it('is in the committed smoke.yml exactly when an app deploys: with nothing deployed, a schedule would start a runner for nothing', () => {
    const text = committedSmoke();
    const project = loadProject();
    if (hasDeploy(project)) {
      expect(scheduleLines(text)).toHaveLength(1);
    } else {
      expect(scheduleLines(text)).toEqual([]);
      expect(text).not.toMatch(/^\s*-?\s*cron:/m);
    }
    // The triggers that cost nothing while nothing is deployed stay either way.
    expect(text).toMatch(/^ {2}push:\n {4}branches: \[develop, main\]/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it('the engine workflow, as the sample input these tests use, has no schedule and no cron', () => {
    const text = realSmoke();
    expect(scheduleLines(text)).toEqual([]);
    expect(text).not.toMatch(/^\s*-?\s*cron:/m);
  });

  it('withSmokeSchedule adds exactly the schedule block, above workflow_dispatch, and nothing else', () => {
    const base = realSmoke();
    const scheduled = withSmokeSchedule(base);
    expect(scheduleLines(scheduled)).toHaveLength(1);
    expect(scheduled).toContain("- cron: '17 */6 * * *'");
    expect(scheduled.indexOf('  schedule:')).toBeLessThan(scheduled.indexOf('  workflow_dispatch:'));
    expect(scheduled.replace(SMOKE_SCHEDULE, '')).toBe(base);
  });

  it('the message deploy:add prints states the same interval as the cron it inserts', () => {
    const cronHours = Number(/- cron: '\d+ \*\/(\d+) \* \* \*'/.exec(SMOKE_SCHEDULE)?.[1]);
    expect(cronHours).toBe(SMOKE_EVERY_HOURS);
    expect(smokeScheduleMessage()).toContain(`every-${cronHours}-hours`);
    expect(smokeScheduleMessage()).not.toMatch(/every-3-hours/);
    expect(SMOKE_SCHEDULE).toContain(`# Every ${cronHours} hours`);
  });

  it('the real CLI prints the schedule message from the constant, not a literal', { timeout: 15_000 }, () => {
    // ROOT is derived from the script's own location, so a copy of project.mjs and
    // deploy/ inside a throwaway root runs the real CLI against that root.
    const tmp = mkdtempSync(join(tmpdir(), 'deploy-add-cli-'));
    try {
      mkdirSync(join(tmp, 'scripts'), { recursive: true });
      cpSync(join(REPO_ROOT, 'scripts/project.mjs'), join(tmp, 'scripts/project.mjs'));
      cpSync(join(REPO_ROOT, 'scripts/deploy'), join(tmp, 'scripts/deploy'), { recursive: true });
      mkdirSync(join(tmp, 'apps/api'), { recursive: true });
      mkdirSync(join(tmp, '.github/workflows'), { recursive: true });
      writeFileSync(join(tmp, SMOKE), realSmoke());
      writeFileSync(
        join(tmp, 'project.json'),
        JSON.stringify({ name: 'thing', apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] } } }, null, 2),
      );
      const run = spawnSync(process.execPath, [join(tmp, 'scripts/deploy/add.mjs'), 'vercel', '--app', 'api', '--project', 'thing-api'], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(smokeScheduleMessage());
      expect(run.stdout).not.toContain('3-hours');
      expect(readFileSync(join(tmp, SMOKE), 'utf8')).toContain(`- cron: '17 */${SMOKE_EVERY_HOURS} * * *'`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('withSmokeSchedule is idempotent, and leaves an existing schedule alone, whatever its cron', () => {
    const once = withSmokeSchedule(realSmoke());
    expect(withSmokeSchedule(once)).toBe(once);
    const custom = realSmoke().replace('  workflow_dispatch:', "  schedule:\n    - cron: '0 6 * * *'\n  workflow_dispatch:");
    expect(withSmokeSchedule(custom)).toBe(custom);
  });

  it('withSmokeSchedule ignores a job named schedule: only the triggers before jobs: count', () => {
    const text = realSmoke().replace('\njobs:\n', '\njobs:\n  schedule:\n    runs-on: ubuntu-latest\n    steps: []\n');
    expect(scheduleLines(text)).toHaveLength(1); // the job, which is not a trigger
    const scheduled = withSmokeSchedule(text);
    expect(scheduled).not.toBe(text);
    expect(scheduled.slice(0, scheduled.indexOf('\njobs:'))).toContain("- cron: '17 */6 * * *'");
    expect(withSmokeSchedule(scheduled)).toBe(scheduled);
  });

  it('withSmokeSchedule refuses a workflow with nowhere to put the schedule, rather than guess', () => {
    expect(() => withSmokeSchedule('name: smoke\non:\n  push:\n')).toThrow(/workflow_dispatch/);
  });

  describe('through addDeploy', () => {
    let root: string;
    let manifestPath: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'deploy-add-smoke-'));
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(join(root, SMOKE), realSmoke());
      manifestPath = join(root, 'project.json');
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            name: 'thing',
            apps: {
              api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] },
              web: { path: 'apps/web', toolchain: 'node', reads: ['apps/web'] },
            },
          },
          null,
          2,
        ),
      );
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('a repo that has never run deploy:add has no schedule; the first run gives it back', () => {
      expect(scheduleLines(readFileSync(join(root, SMOKE), 'utf8'))).toEqual([]);
      const { smoke } = addDeploy({ provider: 'vercel', app: 'api', root, manifestPath });
      expect(smoke).toBe('scheduled');
      expect(scheduleLines(readFileSync(join(root, SMOKE), 'utf8'))).toHaveLength(1);
      expect(readFileSync(join(root, SMOKE), 'utf8')).toBe(withSmokeSchedule(realSmoke()));
    });

    it('running it again, or for a second app, leaves one schedule and the file byte-identical', () => {
      addDeploy({ provider: 'vercel', app: 'api', root, manifestPath });
      const after = readFileSync(join(root, SMOKE), 'utf8');
      expect(addDeploy({ provider: 'vercel', app: 'api', root, manifestPath }).smoke).toBe('unchanged');
      expect(addDeploy({ provider: 'vercel', app: 'web', root, manifestPath }).smoke).toBe('unchanged');
      expect(readFileSync(join(root, SMOKE), 'utf8')).toBe(after);
      expect(scheduleLines(after)).toHaveLength(1);
    });

    it('stops with nothing written when smoke.yml has nowhere to put the schedule', () => {
      writeFileSync(join(root, SMOKE), 'name: smoke\non:\n  push:\n');
      expect(() => addDeploy({ provider: 'vercel', app: 'api', root, manifestPath })).toThrow(/workflow_dispatch/);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8')).apps.api.deploy).toBeUndefined();
      expect(existsSync(join(root, 'apps/api/vercel.json'))).toBe(false);
    });

    it('a repo with no smoke.yml gets its deploy block and says it added no schedule', () => {
      rmSync(join(root, SMOKE));
      const { smoke } = addDeploy({ provider: 'vercel', app: 'api', root, manifestPath });
      expect(smoke).toBe('absent');
      expect(JSON.parse(readFileSync(manifestPath, 'utf8')).apps.api.deploy.provider).toBe('vercel');
      expect(existsSync(join(root, SMOKE))).toBe(false);
    });
  });
});

describe('smokeScheduleProblem: a sync must not silently drop the uptime check', () => {
  const deployedProject = (): Project => ({
    name: 'thing',
    apps: {
      api: {
        path: 'apps/api',
        toolchain: 'python',
        reads: ['apps/api'],
        deploy: { provider: 'vercel', team: 't', project: 'p', url: 'https://p.example', commitEndpoint: '/health' },
      },
    },
  });
  const undeployedProject = (): Project => ({ name: 'thing', apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] } } });

  it('passes for a project that deploys nothing and the engine workflow, which ships without a schedule', () => {
    expect(smokeScheduleProblem(undeployedProject(), realSmoke())).toBeNull();
  });

  it('flags an app with a deploy block when smoke.yml has no schedule, naming the fix', () => {
    const problem = smokeScheduleProblem(deployedProject(), realSmoke());
    expect(problem).toMatch(/deploy/);
    expect(problem).toContain('npm run deploy:add');
    expect(problem).toContain('withSmokeSchedule');
  });

  it('flags it when the only "schedule:" is a job, not a trigger', () => {
    const text = realSmoke().replace('\njobs:\n', '\njobs:\n  schedule:\n    runs-on: ubuntu-latest\n    steps: []\n');
    expect(smokeScheduleProblem(deployedProject(), text)).not.toBeNull();
  });

  it('passes once the schedule is there, which is what deploy:add leaves', () => {
    expect(smokeScheduleProblem(deployedProject(), withSmokeSchedule(realSmoke()))).toBeNull();
  });

  it('does not mind a schedule where nothing is deployed', () => {
    expect(smokeScheduleProblem(undeployedProject(), withSmokeSchedule(realSmoke()))).toBeNull();
  });

  it('is what the committed files satisfy', () => {
    const project = loadProject();
    expect(smokeScheduleProblem(project, committedSmoke()), 'run npm run deploy:add again').toBeNull();
  });
});
