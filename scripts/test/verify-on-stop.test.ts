import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CONSECUTIVE_BLOCKS,
  STATE_DIR,
  ROOT,
  decide,
  parseStatus,
  plan,
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

// Two apps sharing one `reads` entry (package-lock.json); only web reads docs.
const fixture = {
  apps: {
    api: { path: 'apps/api', reads: ['apps/api', 'package-lock.json'], ignores: ['apps/api/README.md'] },
    web: { path: 'apps/web', reads: ['apps/web', 'package-lock.json', 'docs'] },
  },
} as never;
const HARNESS = 'npm run verify:harness';
const API = 'node scripts/verify-apps.mjs api';
const WEB = 'node scripts/verify-apps.mjs web';

describe('plan', () => {
  it('runs one app\'s checks and nothing else when only that app changed', () => {
    expect(plan(['apps/api/src/main.py'], fixture)).toEqual([API]);
  });

  it('runs the harness checks alone when only engine code changed', () => {
    expect(plan(['scripts/foo.mjs', '.claude/hooks/x.mjs'], fixture)).toEqual([HARNESS]);
  });

  it('runs every app whose path or reads holds a shared build input', () => {
    expect(plan(['docs/a.md', 'apps/api/x'], fixture)).toEqual([API, WEB]);
    expect(plan(['package-lock.json'], fixture)).toEqual([HARNESS, API, WEB]);
  });

  it('runs the harness first, then the app, when several areas changed', () => {
    expect(plan(['apps/web/src/a.tsx', 'scripts/foo.mjs'], fixture)).toEqual([HARNESS, WEB]);
  });

  it('runs nothing when no changed file is under a verified path', () => {
    expect(plan(['README.md', 'apps/apiary/x'], fixture)).toEqual([]);
    expect(plan([], fixture)).toEqual([]);
  });

  it('runs the harness and every app when a file that drives the app checks changed', () => {
    for (const file of ['project.json', 'scripts/project.mjs', 'scripts/verify-apps.mjs', 'package.json', 'package-lock.json']) {
      expect(plan([file], fixture)).toEqual([HARNESS, API, WEB]);
    }
  });

  it('does not honour ignores: run more, not less', () => {
    expect(plan(['apps/api/README.md'], fixture)).toEqual([API]);
  });
});

describe('parseStatus', () => {
  it('keeps both paths of a staged rename, so a move between apps plans both', () => {
    const raw = 'R  apps/web/a.py\0apps/api/a.py\0 M scripts/x.mjs\0';
    const files = parseStatus(raw);
    expect(files).toEqual(['apps/web/a.py', 'apps/api/a.py', 'scripts/x.mjs']);
    expect(plan(files, fixture)).toEqual([HARNESS, API, WEB]);
  });

  it('returns a path with a space unquoted, and it matches', () => {
    const files = parseStatus('?? apps/api/my file.py\0');
    expect(files).toEqual(['apps/api/my file.py']);
    expect(plan(files, fixture)).toEqual([API]);
  });

  it('reads an empty status as nothing changed', () => {
    expect(parseStatus('')).toEqual([]);
  });
});

describe('main', () => {
  // Runs the real hook in a throwaway repository whose two checks are fakes:
  // the harness script and scripts/verify-apps.mjs each append to a log, so
  // what ran, and in what order, is observed rather than assumed.
  const setup = (harnessExit: number) => {
    const repo = mkdtempSync(join(tmpdir(), 'vos-repo-'));
    const state = mkdtempSync(join(tmpdir(), 'vos-state-'));
    spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 10_000 });
    mkdirSync(join(repo, '.claude/hooks'), { recursive: true });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps/api'), { recursive: true });
    cpSync(join(REPO_ROOT, '.claude/hooks/verify-on-stop.mjs'), join(repo, '.claude/hooks/verify-on-stop.mjs'));
    cpSync(join(REPO_ROOT, 'scripts/project.mjs'), join(repo, 'scripts/project.mjs'));
    const harness = `require('fs').appendFileSync('ran.log','harness\\n');console.log('boom');process.exit(${harnessExit})`;
    writeFileSync(join(repo, 'harness.cjs'), harness);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'verify:harness': 'node harness.cjs' } }));
    writeFileSync(join(repo, 'scripts/verify-apps.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('ran.log', `app ${process.argv[2]}\\n`);\n");
    writeFileSync(
      join(repo, 'project.json'),
      JSON.stringify({ name: 'fixture', apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'], verify: ['true'] } } }),
    );
    // Commit the scaffolding so only the files below show as changed.
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, timeout: 10_000 });
    git('add', '-A');
    git('commit', '-q', '-m', 'scaffold');
    // One engine file and one app file changed: the plan is harness, then api.
    writeFileSync(join(repo, 'scripts/x.mjs'), 'x');
    writeFileSync(join(repo, 'apps/api/y.py'), 'y');
    const res = spawnSync('node', ['.claude/hooks/verify-on-stop.mjs'], {
      cwd: repo,
      input: JSON.stringify({ session_id: 's', stop_hook_active: false }),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TMPDIR: state },
    });
    const logPath = join(repo, 'ran.log');
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const cleanup = () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    };
    return { res, log, cleanup };
  };

  it('blocks on a red check, counts the attempt, and runs nothing after it', { timeout: 60_000 }, () => {
    const { res, log, cleanup } = setup(1);
    try {
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('npm run verify:harness failed');
      expect(res.stderr).toContain('boom');
      expect(res.stderr).toContain('attempt 1 of 3');
      // The app check is planned but must not have run: a missing break fails here.
      expect(log).toBe('harness\n');
    } finally {
      cleanup();
    }
  });

  it('runs the harness check before the app check, and exits 0 when both are green', { timeout: 60_000 }, () => {
    const { res, log, cleanup } = setup(0);
    try {
      expect(res.status).toBe(0);
      expect(log).toBe('harness\napp api\n');
    } finally {
      cleanup();
    }
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
