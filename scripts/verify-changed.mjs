#!/usr/bin/env node
// `npm run verify:changed`: the checks for what this branch changed, not all of
// `verify`. Changed files come from `git diff --name-only -z origin/develop...HEAD`
// and go through the Stop hook's own `plan()`, so the two never disagree about
// what a change needs. A diff `plan()` maps to nothing runs the full
// `npm run verify`, never nothing. CI (verify.yml) still runs the full thing.
import { execFileSync, execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseStatus, plan } from '../.claude/hooks/verify-on-stop.mjs';
import { loadProject } from './project.mjs';

export const FULL = 'npm run verify';
const HARNESS = 'npm run verify:harness';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const inAiLayer = (file) => file.startsWith('.claude/') || file.startsWith('.github/');

/**
 * The commands for `changed`. `plan()` already runs the harness checks for
 * `scripts/` and `.claude/hooks`; the rest of `.claude/` and `.github/` is the
 * AI layer too, so it is added here, first, as `plan()` orders it. Empty plan:
 * the full `verify`.
 */
export function commandsFor(changed, project) {
  const commands = plan(changed, project);
  if (changed.some(inAiLayer) && !commands.includes(HARNESS)) commands.unshift(HARNESS);
  return commands.length > 0 ? commands : [FULL];
}

/**
 * Committed changes against develop plus the working tree's modified and
 * untracked files: verify runs before the commit, so the diff alone misses
 * uncommitted work. Pure over the two git outputs, so it is testable.
 */
export function unionChanged(diffOut, statusRaw) {
  const files = [...new Set([...diffOut.split('\0').filter(Boolean), ...parseStatus(statusRaw)])];
  // `-z` never quotes; a leading quote means git handed back a path we cannot
  // match to a prefix, so refuse the list and let `planFrom` run the full verify.
  const quoted = files.find((f) => f.startsWith('"'));
  if (quoted) throw new Error(`git listed a path it quoted: ${quoted}`);
  return files;
}

export function changedFiles() {
  const out = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return unionChanged(
    out(['diff', '--name-only', '-z', 'origin/develop...HEAD']),
    out(['status', '--porcelain=v1', '-z', '-uall']),
  );
}

/**
 * The plan from `getChanged()`; if git fails (no `origin/develop`, not a
 * repository), the full `verify` and a one-line warning rather than a throw.
 */
export function planFrom(getChanged, project) {
  try {
    return { commands: commandsFor(getChanged(), project), warning: null };
  } catch (err) {
    const why = String(err?.message ?? err).split('\n')[0];
    return { commands: [FULL], warning: `verify:changed: cannot list changed files (${why}); running the full verify` };
  }
}

function main() {
  const { commands, warning } = planFrom(changedFiles, loadProject());
  if (warning) console.warn(warning);
  console.log(`verify:changed plan:\n${commands.map((c) => `  ${c}`).join('\n')}`);
  for (const command of commands) {
    try {
      execSync(command, { cwd: ROOT, stdio: 'inherit' });
    } catch {
      console.error(`verify:changed: "${command}" failed`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
