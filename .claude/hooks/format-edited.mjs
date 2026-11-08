#!/usr/bin/env node
// PostToolUse hook: autofix the file that was just edited, so trivial lint
// failures never become a round trip.
//
// Same cwd rule as the Stop hook: derive the root from this file, pin every
// command to it.
//
// The file path comes from whatever Claude Code just edited — a repository
// file, so its name is untrusted input that can arrive by pull request,
// archive, or clone. The previous version built a shell command line with
// `${JSON.stringify(filePath)}`. JSON.stringify escapes `"` and `\` but not
// backticks or `$`, and execSync runs the string through `sh` on POSIX, so a
// file named e.g. "a`whoami`.py" ran command substitution the moment this
// hook fired. Every command below goes through execFileSync with an argv
// array and no shell, so the path is one inert argument no matter what
// characters — backticks, `$(...)`, quotes, semicolons, spaces — it contains.
// There is no parser left for those characters to be special to.
//
// uv is a real binary on every platform (not a shim), so it can be launched
// directly. npx/npm are `.cmd` shims on Windows, which execFile cannot run
// without a shell — so for eslint we skip npx entirely and run its actual JS
// entry point through `node` (process.execPath), which is a real executable
// everywhere and never needs one.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appFor, loadProject } from '../../scripts/project.mjs';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Resolves eslint's CLI entry point from the repo root, or null if it isn't
 * installed. eslint's package.json restricts subpath imports through
 * "exports", so `require.resolve('eslint/bin/eslint.js')` is refused even
 * though the file exists — go by the package's own published `bin` field
 * instead, the same contract `npx eslint` relies on.
 */
function resolveEslintBin() {
  try {
    const require = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
    const pkgPath = require.resolve('eslint/package.json');
    const bin = require(pkgPath).bin;
    const binRelative = typeof bin === 'string' ? bin : bin?.eslint;
    return binRelative ? join(dirname(pkgPath), binRelative) : null;
  } catch {
    return null; // Nothing to fix with if eslint isn't installed.
  }
}

/**
 * Returns the commands that would run, so the routing is testable. Each
 * entry is an argv descriptor — never a shell string — so a caller can only
 * ever pass `filePath` through as one argument.
 */
export function fixCommands(filePath, project = loadProject()) {
  if (/\.py$/.test(filePath)) {
    // Ruff runs in the Python app that holds the file, with that app's own
    // config (project.json). A Python file outside every Python app is
    // left alone rather than linted against a neighbour's rules.
    const owner = appFor(project, relative(ROOT, resolve(ROOT, filePath)));
    if (!owner || owner[1].toolchain !== 'python') return [];
    const directory = owner[1].path;
    return [
      { command: 'uv', args: ['run', '--directory', directory, 'ruff', 'check', '--fix', filePath] },
      { command: 'uv', args: ['run', '--directory', directory, 'ruff', 'format', filePath] },
    ];
  }
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
    const eslintBin = resolveEslintBin();
    return eslintBin ? [{ command: process.execPath, args: [eslintBin, '--fix', filePath] }] : [];
  }
  return [];
}

/**
 * Runs every command fixCommands routes filePath to, with no shell involved.
 * `exec` defaults to the real execFileSync and is only ever overridden by
 * tests — Node's builtin modules sit outside Vite's module graph, so mocking
 * `node:child_process` itself does not reliably reach every importer, and
 * dependency injection is the straightforward way to observe the exact argv
 * this function passes on without touching that module.
 */
export function runFixes(filePath, { exec = execFileSync, project } = {}) {
  for (const { command, args } of fixCommands(filePath, project)) {
    try {
      // shell is left at its default of false: execFileSync hands `command`
      // straight to the OS with `args` as a literal argv array, so nothing
      // ever re-parses the path.
      exec(command, args, { cwd: ROOT, stdio: 'ignore' });
    } catch {
      // A file that cannot be autofixed is the linter's problem to report
      // during verify, not this hook's problem to block on.
    }
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  let filePath;
  try {
    filePath = JSON.parse(input)?.tool_input?.file_path;
  } catch {
    return;
  }
  if (!filePath) return;

  runFixes(filePath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
