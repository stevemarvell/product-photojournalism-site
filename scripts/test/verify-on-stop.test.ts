import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CONSECUTIVE_BLOCKS,
  STATE_DIR,
  ROOT,
  decide,
  parseStopInput,
  readCount,
  statePath,
  writeCount,
} from '../../.claude/hooks/verify-on-stop.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('decide', () => {
  it('allows a green run and clears the count', () => {
    expect(decide({ green: true, previous: 2, continuing: true })).toEqual({ action: 'allow', count: null });
  });

  it('blocks the first red run of a turn', () => {
    expect(decide({ green: false, previous: 0, continuing: false })).toEqual({ action: 'block', count: 1 });
  });

  it('blocks the second red in a row', () => {
    expect(decide({ green: false, previous: 1, continuing: true })).toEqual({ action: 'block', count: 2 });
  });

  it('stops blocking at the third red in a row, and reports instead', () => {
    expect(decide({ green: false, previous: 2, continuing: true })).toEqual({ action: 'report', count: null });
  });

  it('never blocks more than the ceiling in one chain, however it is driven', () => {
    let previous = 0;
    let blocks = 0;
    for (let stop = 0; stop < 10; stop++) {
      const { action, count } = decide({ green: false, previous, continuing: stop > 0 });
      if (action === 'report') break;
      blocks++;
      previous = count ?? 0;
    }
    expect(blocks).toBe(MAX_CONSECUTIVE_BLOCKS - 1);
  });

  it('starts a fresh chain when the stop did not follow a block', () => {
    // A stale count from an earlier turn must not shorten this one.
    expect(decide({ green: false, previous: 2, continuing: false })).toEqual({ action: 'block', count: 1 });
  });
});

describe('parseStopInput', () => {
  // The shape Claude Code sends a Stop hook on stdin. If these field names
  // drift, `continuing` goes permanently false and the ceiling never fires.
  const payload = (stopHookActive: boolean) =>
    JSON.stringify({
      session_id: 'abc-123',
      transcript_path: '/home/u/.claude/projects/p/abc-123.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      stop_hook_active: stopHookActive,
    });

  it('reads the session and a continuation from a real Stop payload', () => {
    expect(parseStopInput(payload(true))).toEqual({ sessionId: 'abc-123', continuing: true });
  });

  it('reads a first stop as not continuing', () => {
    expect(parseStopInput(payload(false))).toEqual({ sessionId: 'abc-123', continuing: false });
  });

  it('drives the ceiling end to end from payloads alone', () => {
    let previous = 0;
    const actions: string[] = [];
    for (const active of [false, true, true]) {
      const { continuing } = parseStopInput(payload(active));
      const { action, count } = decide({ green: false, previous, continuing });
      actions.push(action);
      previous = count ?? 0;
    }
    expect(actions).toEqual(['block', 'block', 'report']);
  });

  it('treats empty or malformed stdin as a first stop, never as a continuation', () => {
    expect(parseStopInput('')).toEqual({ sessionId: undefined, continuing: false });
    expect(parseStopInput('not json')).toEqual({ sessionId: undefined, continuing: false });
    expect(parseStopInput(JSON.stringify({ stop_hook_active: 'true' })).continuing).toBe(false);
  });
});

describe('the ceiling', () => {
  it('is the three attempts ship.md declares, so the two cannot drift', () => {
    const ship = readFileSync(join(REPO_ROOT, '.claude', 'commands', 'ship.md'), 'utf8');
    expect(MAX_CONSECUTIVE_BLOCKS).toBe(3);
    expect(ship).toMatch(/three attempts/);
  });
});

describe('the count file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-on-stop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lives outside the checkout, so it cannot trip the hook it serves', () => {
    expect(resolve(STATE_DIR).startsWith(resolve(ROOT))).toBe(false);
  });

  it('keeps sessions apart and cannot be steered out of its directory', () => {
    expect(statePath('abc-123', dir)).toBe(join(dir, 'abc-123.json'));
    expect(statePath('../../etc/passwd', dir)).toBe(join(dir, '______etc_passwd.json'));
    expect(statePath(undefined, dir)).toBe(join(dir, 'unknown.json'));
  });

  it('round-trips a count, and clearing it removes the file', () => {
    const path = statePath('s', dir);
    expect(readCount(path)).toBe(0);
    writeCount(path, 2);
    expect(readCount(path)).toBe(2);
    writeCount(path, null);
    expect(readCount(path)).toBe(0);
  });

  it('reads a corrupt or nonsense file as zero rather than throwing', () => {
    const path = statePath('s', dir);
    writeFileSync(path, 'not json');
    expect(readCount(path)).toBe(0);
    writeFileSync(path, JSON.stringify({ count: -4 }));
    expect(readCount(path)).toBe(0);
  });
});
