#!/usr/bin/env node
// Prepare a fresh worktree: install every app's toolchain and report the ports this
// checkout will use. node_modules and .venv are per-worktree, not shared.
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingPackages } from './lsp.mjs';
import { apps, hasE2e, loadProject } from './project.mjs';
import { BAND, BASE_PORT, portOffset } from './ports.mjs';

/**
 * The commands that install what `project` needs, in order. A product with no
 * apps needs only the root install; a browser is for an app's end-to-end
 * suite, so one is fetched only when some app's verify runs one (hasE2e, the
 * same fact verify.yml gates its Playwright steps on).
 */
export function installCommands(project) {
  const commands = ['npm ci'];
  // Every Python app in project.json; node apps are npm workspaces.
  for (const [, app] of apps(project, 'python')) commands.push(`uv sync --directory ${app.path} --frozen`);
  if (hasE2e(project)) commands.push('npx playwright install chromium');
  return commands;
}

// `uv sync` rewrites nothing in .venv when the packages already match, so
// neither the directory's nor pyvenv.cfg's mtime says when the last install
// ran (measured, #361). A stamp written after a successful install does.
export const STAMP = '.bootstrap-stamp';

/** Write each Python app's stamp, now; call only after the installs succeeded. */
export function writeStamps(root, project, stderr = process.stderr) {
  for (const [, app] of apps(project, 'python')) {
    if (!existsSync(join(root, app.path, '.venv'))) {
      stderr.write(`bootstrap: no .venv for ${app.path}, so no stamp written\n`);
      continue;
    }
    writeFileSync(join(root, app.path, '.venv', STAMP), `${new Date().toISOString()}\n`);
  }
}

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The whole bootstrap, with the side effects injected: every install command
 * (including the browser), then the stamps, then the global language servers.
 * `run(command)` executes one command; `stdout` and `stderr` take the reports.
 */
export function bootstrap({ root = ROOT, project = loadProject(), run, packages = missingPackages(), stdout = process.stdout, stderr = process.stderr }) {
  for (const command of installCommands(project)) run(command);

  writeStamps(root, project, stderr);

  // Language servers for the LSP plugins in .claude/settings.json -- global,
  // because the plugins only look on PATH. See scripts/lsp.mjs.
  if (packages.length) run(`npm install -g ${packages.join(' ')}`);

  // Which servers an app's e2e suite starts is the app's business (its own
  // ports() call), so this reports only the rule and this worktree's offset,
  // not a list of names it would have to guess.
  const offset = portOffset();
  stdout.write(
    `\nThis worktree's E2E port offset is ${offset}: the nth server an e2e config names gets ` +
      `${BASE_PORT} + ${BAND}×(n-1) + ${offset}, so the first is ${BASE_PORT + offset}.\n` +
      `Derived from the directory name, so parallel worktrees do not collide.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootstrap({
    run: (command) => {
      process.stdout.write(`$ ${command}\n`);
      execSync(command, { stdio: 'inherit', cwd: ROOT });
    },
  });
}
