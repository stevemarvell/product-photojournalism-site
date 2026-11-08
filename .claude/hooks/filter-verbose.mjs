#!/usr/bin/env node
// PreToolUse hook: shrink the output of commands whose bulk is never read.
//
// A hook runs outside the model loop, so filtering here costs **zero tokens**,
// where a subagent summarising the same output costs whatever it spends. That
// is the whole reason this exists rather than a "read the log" skill: the
// cheapest model is no model.
//
// Measured motivation: `gh run view --log` against a CI log of a few
// thousand lines lets every one of those lines enter the conversation and
// then be re-sent on every subsequent request at the cached rate, when what
// was wanted was the failing step and the first real error.
//
// Two rules keep this from hiding something that mattered:
//
//   1. **A command that already redirects or pipes is left alone.** If a
//      caller wrote their own filter they know what they want, and wrapping it
//      would fight them.
//   2. **Filters keep failure context, not just matches.** Grep is given -A so
//      the lines after an error come too, and the cap is generous. A filter
//      that hides the reason for a failure costs a re-run, which is more than
//      it saved.
//
// Anything not matched is passed through untouched. This is a narrow list of
// known-verbose commands, not a general policy.
import { pathToFileURL } from 'node:url';

export const ROOT = new URL('../..', import.meta.url).pathname;

// A pipe, a redirect, or a command separator means the caller has already said
// what they want done with the output.
const ALREADY_SHAPED = /[|><]|&&|;/;

/**
 * Commands worth shrinking, most verbose first.
 *
 * `match` decides; `filter` is appended verbatim. Each filter ends in a cap, so
 * a pathological input cannot pour thousands of lines through a grep that
 * happens to match everything.
 */
export const FILTERS = [
  {
    name: 'gh-run-log',
    // Actions logs are the worst offender here by an order of magnitude.
    match: (command) => /\bgh\s+run\s+view\b/.test(command) && /--log(-failed)?\b/.test(command),
    filter: "2>&1 | grep -iE -A2 'error|fail|✘|##\\[error\\]|Process completed' | head -60",
  },
  {
    name: 'verify',
    match: (command) => /\bnpm\s+run\s+verify(:\w+)?\s*$/.test(command),
    filter: "2>&1 | grep -E -A3 'passed|failed|error|Error|All checks|✘|FAIL' | head -40",
  },
  {
    name: 'npm-audit',
    match: (command) => /\bnpm\s+audit\b/.test(command),
    filter: '2>&1 | tail -25',
  },
  {
    name: 'docker-build',
    match: (command) => /\bdocker\s+build\b/.test(command),
    filter: '2>&1 | tail -30',
  },
];

/**
 * Returns the rewritten command and which filter did it, or null to pass
 * through. Pure, so the decision is testable without a shell.
 */
export function filterCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (ALREADY_SHAPED.test(command)) return null;

  for (const { name, match, filter } of FILTERS) {
    if (match(command)) return { name, command: `${command.trim()} ${filter}` };
  }
  return null;
}

/** The JSON a PreToolUse hook prints to rewrite a Bash command, or pass it on. */
export function decide(payload) {
  if (payload?.tool_name !== 'Bash') return {};

  const rewritten = filterCommand(payload?.tool_input?.command);
  if (!rewritten) return {};

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...payload.tool_input, command: rewritten.command },
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A hook that cannot parse its input must not block the tool call. An
    // empty object is "no opinion", which is the safe answer.
    process.stdout.write('{}');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(decide(payload)));
}
