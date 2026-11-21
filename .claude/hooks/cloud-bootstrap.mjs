#!/usr/bin/env node
// SessionStart hook: install both toolchains in cloud sessions only, and only
// when they are missing or stale.
//
// The cloud environment's setup script is the place for the install: it runs
// once, after the repositories are cloned and before Claude starts, and the
// result is cached (README.md, "Start a new project from this base", gives the
// line to save). This hook is the fallback for an environment with no setup
// script, and a cheap check otherwise: when node_modules is at least as new as
// package-lock.json and every Python app's bootstrap stamp is newer than its manifests, it prints
// "bootstrap: up to date" and returns. It is gated on CLAUDE_CODE_REMOTE so it
// is a no-op locally, and runs on startup and resume.
import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAMP } from '../../scripts/bootstrap.mjs';
import { apps, loadProject } from '../../scripts/project.mjs';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// What `uv sync --frozen` reads for a Python app (scripts/bootstrap.mjs).
const PYTHON_MANIFESTS = ['pyproject.toml', 'uv.lock'];

const realFs = { exists: existsSync, mtimeMs: (path) => statSync(path).mtimeMs };

/**
 * True when the installs are already done: node_modules/.package-lock.json is
 * at least as new as package-lock.json, and every Python app has a bootstrap
 * stamp (.venv/.bootstrap-stamp) at least as new as its pyproject.toml and uv.lock.
 * `fs` is injected ({ exists(path), mtimeMs(path) }) so tests need no install.
 */
export function upToDate(root, project, fs = realFs) {
  const marker = join(root, 'node_modules', '.package-lock.json');
  if (!fs.exists(marker)) return false;
  const lock = join(root, 'package-lock.json');
  if (fs.exists(lock) && fs.mtimeMs(lock) > fs.mtimeMs(marker)) return false;
  for (const [, app] of apps(project, 'python')) {
    // The stamp, not .venv: uv sync leaves .venv's mtime alone (#361).
    const stamp = join(root, app.path, '.venv', STAMP);
    if (!fs.exists(stamp)) return false;
    // A dependency manifest changed after the last successful bootstrap.
    for (const manifest of PYTHON_MANIFESTS) {
      const path = join(root, app.path, manifest);
      if (fs.exists(path) && fs.mtimeMs(path) > fs.mtimeMs(stamp)) return false;
    }
  }
  return true;
}

function main() {
  if (process.env['CLAUDE_CODE_REMOTE'] !== 'true') return 0;

  if (upToDate(ROOT, loadProject())) {
    process.stdout.write('bootstrap: up to date\n');
    return 0;
  }
  execSync('npm run bootstrap', { cwd: ROOT, stdio: 'inherit' });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
