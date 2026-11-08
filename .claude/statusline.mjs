#!/usr/bin/env node
// Status line: show what the conversation is costing, and say when to clear.
//
// SOP 4 in docs/sops.md says clear between unrelated tasks, and that is the
// largest saving available here. The trouble is that it is a habit, and the
// moment to do it is invisible — nothing in the terminal changes as context
// grows, so a session drifts through four topics and re-sends the first three
// on every turn.
//
// This runs as a shell command outside the model loop, so it costs **zero
// tokens** to display, however often it redraws.
//
// It shows three numbers, because they answer different questions:
//
//   ctx   how much of this conversation is being re-sent every turn
//   5h    the rolling session window — the one that kills subagents mid-task
//   wk    the weekly window, which is the one that actually runs out
//
// The nudge fires on the two states where clearing is worth most:
//
//   1. **A large context.** Every turn re-sends it, cached but not free.
//   2. **A cold cache with a non-trivial context.** The next message
//      reprocesses the whole conversation at the uncached rate. Cold and large
//      together is the most expensive single message you can send, and the
//      cheapest moment to start again.
import { pathToFileURL } from 'node:url';

/** Context share above which re-sending the conversation is worth avoiding. */
export const CLEAR_AT_PERCENT = 50;

/** With a cold cache the next message pays full price, so nudge sooner. */
export const COLD_CACHE_CLEAR_AT_PERCENT = 25;

const pct = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

/** A five-cell bar. Cheaper to read at a glance than a number alone. */
function bar(percent) {
  if (percent === null) return '';
  const filled = Math.max(0, Math.min(5, Math.round(percent / 20)));
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

/**
 * Whether to tell the reader to clear, and why. Separate from rendering so the
 * rule is testable without parsing a string.
 */
export function clearAdvice({ contextPercent, cacheWarm }) {
  if (contextPercent === null) return null;
  if (cacheWarm === false && contextPercent >= COLD_CACHE_CLEAR_AT_PERCENT) {
    return 'cache cold — /clear costs nothing, this context does';
  }
  if (contextPercent >= CLEAR_AT_PERCENT) return '/clear between tasks';
  return null;
}

/** Builds the line. Pure: give it a payload, get the string. */
export function render(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};

  const model = data.model?.display_name ?? 'claude';
  const worktree = data.workspace?.git_worktree;

  const contextPercent = pct(data.context_window?.used_percentage);
  const fiveHour = pct(data.rate_limits?.five_hour?.used_percentage);
  const week = pct(data.rate_limits?.seven_day?.used_percentage);
  const cacheWarm = data.prompt_cache?.warm;

  const parts = [worktree ? `${model} · ${worktree}` : model];

  if (contextPercent !== null) parts.push(`ctx ${bar(contextPercent)} ${contextPercent}%`);

  // One cell for both windows: they are read together or not at all.
  const limits = [fiveHour === null ? null : `5h ${fiveHour}%`, week === null ? null : `wk ${week}%`]
    .filter(Boolean)
    .join(' · ');
  if (limits) parts.push(limits);

  const advice = clearAdvice({ contextPercent, cacheWarm });

  // A cold cache is worth flagging on its own, but not twice — when the advice
  // already explains it, that sentence is the better place for it.
  if (cacheWarm === false && !advice?.includes('cache cold')) parts.push('cache cold');
  if (advice) parts.push(`⚠ ${advice}`);

  return parts.join(' │ ');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // A status line that throws leaves the bar blank and tells the reader
    // nothing. Printing the model name alone is a better failure.
  }
  process.stdout.write(render(payload));
}
