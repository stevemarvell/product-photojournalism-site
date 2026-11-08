import { describe, expect, it } from 'vitest';
import { apps, loadProject, type Project } from '../project.mjs';
import { nothingToRun, plan, run, type Step } from '../verify-apps.mjs';

const project = (): Project => ({
  name: 'thing',
  apps: {
    back: { path: 'apps/back', toolchain: 'python', verify: ['uv run ruff check .', 'uv run pytest -q'], reads: ['apps/back'] },
    front: { path: 'apps/front', toolchain: 'node', verify: ['npm test'], reads: ['apps/front'] },
    quiet: { path: 'apps/quiet', toolchain: 'node', reads: ['apps/quiet'] },
  },
});

describe('plan', () => {
  it("runs every app's own commands, in manifest order, from its own directory", () => {
    expect(plan(project())).toEqual([
      { app: 'back', cwd: 'apps/back', command: 'uv run ruff check .' },
      { app: 'back', cwd: 'apps/back', command: 'uv run pytest -q' },
      { app: 'front', cwd: 'apps/front', command: 'npm test' },
    ]);
  });

  it('runs only the apps named, in the order named', () => {
    expect(plan(project(), ['front', 'back']).map((s) => s.app)).toEqual(['front', 'back', 'back']);
  });

  it('refuses an app project.json does not declare, rather than skipping it', () => {
    expect(() => plan(project(), ['nope'])).toThrow(/no app named "nope"/);
  });
});

describe('a project with no apps (an engine-only product)', () => {
  const engineOnly = (): Project => ({ name: 'thing', engine: { commit: 'a'.repeat(40) }, apps: {} });

  it('plans nothing, and says why so that passing is not mistaken for having run something', () => {
    const steps = plan(engineOnly());
    expect(steps).toEqual([]);
    expect(nothingToRun(engineOnly(), steps)).toBe('verify:apps: project.json declares no apps; nothing to run');
    expect(run(steps, { exec: () => { throw new Error('ran something'); }, log: () => {} })).toBeNull();
  });

  it('says nothing about an empty plan when there is something to run, and tells no-verify apps from no apps', () => {
    expect(nothingToRun(project(), plan(project()))).toBeNull();
    const quiet: Project = { name: 'thing', apps: { quiet: project().apps.quiet! } };
    expect(nothingToRun(quiet, plan(quiet))).toBe('verify:apps: no app declares any verify command; nothing to run');
  });

  it('still refuses a named app, saying there are none', () => {
    expect(() => plan(engineOnly(), ['web'])).toThrow(/no app named "web".*it declares no apps/);
  });
});

describe('run', () => {
  it('stops at the first failing command and says which', () => {
    const ran: string[] = [];
    const exec = (command: string) => {
      ran.push(command);
      if (command === 'uv run pytest -q') throw new Error('exit 1');
    };
    const failed = run(plan(project()), { exec, log: () => {} });
    expect(failed).toEqual<Step>({ app: 'back', cwd: 'apps/back', command: 'uv run pytest -q' });
    expect(ran).toEqual(['uv run ruff check .', 'uv run pytest -q']);
  });

  it('runs each command in its app directory, and reports nothing when all pass', () => {
    const cwds: string[] = [];
    const exec = (_: string, options: { cwd: string }) => {
      cwds.push(options.cwd.replace(/\\/g, '/'));
    };
    expect(run(plan(project()), { exec, log: () => {} })).toBeNull();
    expect(cwds.every((cwd) => /apps\/(back|front)$/.test(cwd))).toBe(true);
  });
});

describe('the committed project.json', () => {
  it('gives every app something to verify, so none drops out of the contract silently', () => {
    for (const [name, app] of apps(loadProject())) {
      expect(app.verify?.length ?? 0, name).toBeGreaterThan(0);
    }
  });
});
