#!/usr/bin/env node
// Stop hook: refuse to finish while the verification loop is red — up to a
// ceiling.
//
// Exit 0 lets the turn end. Exit 2 blocks it and feeds stderr back to the
// model, so a failing gate becomes work to do rather than a claim to make.
//
// Blocking is what creates the fix-and-retry loop, so this hook is where
// SOP 1's ceiling can be enforced rather than only followed. It counts
// consecutive blocks within one chain of continuations — Claude Code sets
// `stop_hook_active` on a stop that follows a block — and at the third red in
// a row it lets the turn end and reports instead, the same three attempts
// `.claude/commands/ship.md` declares. A green run clears the count, and so
// does a fresh turn: a person replying is the "someone looks at it" the
// ceiling exists to reach.
//
// The count lives outside the checkout, keyed by session, because each stop
// is a new process and a file in the repository would show up in
// `git status` and trip this very hook.
//
// Paths are derived from this file's own location and every command is run
// with cwd pinned to the repository root: a hook fires with whatever working
// directory the session happens to be in, and a relative path fails outright
// from a subdirectory. Commands go through a shell because npm is a .cmd shim
// on Windows and execFile cannot launch those.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProject, verifiedPaths } from '../../scripts/project.mjs';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Consecutive red `verify` runs before the hook stops blocking. Matches ship.md. */
export const MAX_CONSECUTIVE_BLOCKS = 3;

export const STATE_DIR = join(tmpdir(), 'claude-verify-on-stop');

const run = (command) =>
  execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// What `verify` covers comes from project.json: every app's directory and
// build inputs, and the AI layer's own code. A hardcoded list of paths would
// silently drift from that as apps come and go; reading it from project.json
// means an app's data directory moving is a data-only edit that still
// triggers this hook. git does the matching.
export function changedFiles(paths = verifiedPaths(loadProject())) {
  return execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * What to do with a finished `verify`, given how many times in a row this
 * chain of stops has already been blocked. Pure, so the ceiling is testable.
 *
 * Returns the action and the count to store: `null` means clear it.
 */
export function decide({ green, previous, continuing }) {
  if (green) return { action: 'allow', count: null };
  // A stop that did not follow a block starts a new chain.
  const count = (continuing ? previous : 0) + 1;
  if (count >= MAX_CONSECUTIVE_BLOCKS) return { action: 'report', count: null };
  return { action: 'block', count };
}

/** The file holding this session's count. Session ids are sanitised into a name. */
export function statePath(sessionId, dir = STATE_DIR) {
  const name = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(dir, `${name}.json`);
}

export function readCount(path) {
  try {
    const { count } = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export function writeCount(path, count) {
  if (count === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ count }), 'utf8');
}

/**
 * The two fields of Claude Code's Stop-hook payload the ceiling depends on.
 * `session_id` and `stop_hook_active` are load-bearing names: if either
 * stopped matching, `continuing` would always be false, every red would start
 * a new chain, and the hook would block forever — so this is exported and
 * tested against the payload's real shape rather than left inline in main().
 */
export function parseStopInput(raw) {
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    input = {};
  }
  return { sessionId: input.session_id, continuing: input.stop_hook_active === true };
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let changed;
  try {
    changed = changedFiles();
  } catch {
    return 0; // not a git repo, or git unavailable — do not block
  }
  if (changed.length === 0) return 0;

  const { sessionId, continuing } = parseStopInput(readStdin());
  const path = statePath(sessionId);

  let failure = null;
  try {
    run('npm run verify');
  } catch (err) {
    failure = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
  }

  const { action, count } = decide({
    green: failure === null,
    previous: readCount(path),
    continuing,
  });
  try {
    writeCount(path, count);
  } catch {
    // An unwritable temp directory costs the ceiling, never the gate itself.
  }

  if (action === 'allow') return 0;

  if (action === 'report') {
    // Exit 0 with a systemMessage: the turn ends and the person sees why.
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `npm run verify is still red after ${MAX_CONSECUTIVE_BLOCKS} consecutive attempts, so the stop hook ` +
          `has stopped blocking (SOP 1). The work is NOT done. Last failure:\n\n${failure}`,
      }),
    );
    return 0;
  }

  process.stderr.write(
    `npm run verify failed, so this work is not done (attempt ${count} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n` +
      `${failure}\n\n` +
      `Fix it and run "npm run verify" again. Do not report the work as complete until it passes.\n`,
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
