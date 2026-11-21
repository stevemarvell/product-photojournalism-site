import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, installCommands, STAMP } from '../bootstrap.mjs';
import { loadProject, type Project } from '../project.mjs';

const engine = { commit: 'a'.repeat(40) };

describe('installCommands', () => {
  it('installs the root, every Python app and a browser when a verify command runs e2e', () => {
    const project: Project = {
      name: 'thing',
      apps: {
        back: { path: 'apps/back', toolchain: 'python', reads: ['apps/back'] },
        front: { path: 'apps/front', toolchain: 'node', reads: ['apps/front'], verify: ['npm run e2e'] },
      },
    };
    expect(installCommands(project)).toEqual(['npm ci', 'uv sync --directory apps/back --frozen', 'npx playwright install chromium']);
  });

  it('installs no browser for a project with no node app, and no Python environment for one with no Python app', () => {
    const pythonOnly: Project = { name: 'thing', apps: { back: { path: 'apps/back', toolchain: 'python', reads: ['apps/back'] } } };
    expect(installCommands(pythonOnly)).toEqual(['npm ci', 'uv sync --directory apps/back --frozen']);
    const nodeOnly: Project = { name: 'thing', apps: { front: { path: 'apps/front', toolchain: 'node', reads: ['apps/front'], verify: ['npx playwright test'] } } };
    expect(installCommands(nodeOnly)).toEqual(['npm ci', 'npx playwright install chromium']);
  });

  it('installs no browser for a node app whose verify has no e2e command', () => {
    const noE2e: Project = { name: 'thing', apps: { front: { path: 'apps/front', toolchain: 'node', reads: ['apps/front'], verify: ['npm run test'] } } };
    expect(installCommands(noE2e)).toEqual(['npm ci']);
  });

  it('installs a browser for a Python app whose verify runs e2e tests', () => {
    const py: Project = { name: 'thing', apps: { back: { path: 'apps/back', toolchain: 'python', reads: ['apps/back'], verify: ['uv run pytest tests/e2e'] } } };
    expect(installCommands(py)).toEqual(['npm ci', 'uv sync --directory apps/back --frozen', 'npx playwright install chromium']);
  });

  it('installs only the root for an engine-only product: no uv, no browser', () => {
    expect(installCommands({ name: 'thing', engine, apps: {} })).toEqual(['npm ci']);
  });

  it("covers the committed project.json's own apps", () => {
    const project = loadProject();
    const commands = installCommands(project);
    expect(commands[0]).toBe('npm ci');
    expect(commands.filter((c) => c.startsWith('uv sync')).length).toBe(Object.values(project.apps).filter((a) => a.toolchain === 'python').length);
  });
});

describe('bootstrap', () => {
  const python: Project = {
    name: 'thing',
    apps: { back: { path: 'apps/back', toolchain: 'python', reads: ['apps/back'], verify: ['npm run e2e'] } },
  };
  const sink = () => {
    const out: string[] = [];
    return { out, write: (s: string) => out.push(s) };
  };

  it('stamps each Python app after the installs, and runs the browser and language-server steps', () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    try {
      mkdirSync(join(root, 'apps', 'back', '.venv'), { recursive: true });
      const ran: string[] = [];
      const stampsAtInstall: boolean[] = [];
      bootstrap({
        root,
        project: python,
        packages: ['some-lsp'],
        stdout: sink(),
        stderr: sink(),
        run: (c: string) => {
          ran.push(c);
          stampsAtInstall.push(existsSync(join(root, 'apps', 'back', '.venv', STAMP)));
        },
      });
      expect(existsSync(join(root, 'apps', 'back', '.venv', STAMP))).toBe(true);
      expect(ran).toEqual([...installCommands(python), 'npm install -g some-lsp']);
      // Not stamped before the last install ran: the stamp means "installs succeeded".
      expect(stampsAtInstall.slice(0, -1).every((x) => !x)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not stamp when an install fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    try {
      mkdirSync(join(root, 'apps', 'back', '.venv'), { recursive: true });
      const run = () => {
        throw new Error('uv failed');
      };
      expect(() => bootstrap({ root, project: python, packages: [], stdout: sink(), stderr: sink(), run })).toThrow('uv failed');
      expect(existsSync(join(root, 'apps', 'back', '.venv', STAMP))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips an app with no .venv, says so on stderr, and still runs the later steps', () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    try {
      const err = sink();
      const ran: string[] = [];
      bootstrap({ root, project: python, packages: ['some-lsp'], stdout: sink(), stderr: err, run: (c: string) => ran.push(c) });
      expect(err.out.join('')).toContain('no .venv for apps/back');
      expect(existsSync(join(root, 'apps', 'back'))).toBe(false);
      expect(ran).toContain('npx playwright install chromium');
      expect(ran).toContain('npm install -g some-lsp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
