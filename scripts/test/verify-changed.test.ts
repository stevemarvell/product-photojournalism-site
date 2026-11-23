import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_CHECK_DRIVERS } from '../../.claude/hooks/verify-on-stop.mjs';
import { FULL, commandsFor, planFrom, unionChanged } from '../verify-changed.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const fixture = {
  apps: {
    api: { path: 'apps/api', reads: ['apps/api', 'package-lock.json'], ignores: [] },
    web: { path: 'apps/web', reads: ['apps/web', 'package-lock.json', 'docs'], ignores: [] },
  },
} as never;
const HARNESS = 'npm run verify:harness';
const API = 'node scripts/verify-apps.mjs api';
const WEB = 'node scripts/verify-apps.mjs web';

describe('verify:changed commandsFor', () => {
  it('runs only the harness checks for a diff in scripts/, .claude/ and .github/', () => {
    const changed = ['scripts/foo.mjs', '.claude/agents/implementer.md', '.github/workflows/verify.yml'];
    expect(commandsFor(changed, fixture)).toEqual([HARNESS]);
    expect(commandsFor(['.claude/commands/ship.md'], fixture)).toEqual([HARNESS]);
    expect(commandsFor(['.github/workflows/verify.yml'], fixture)).toEqual([HARNESS]);
  });

  it('runs only that app for a diff under its path', () => {
    expect(commandsFor(['apps/api/src/main.py'], fixture)).toEqual([API]);
  });

  it('adds the harness first when engine code changed with the app', () => {
    expect(commandsFor(['apps/web/src/a.tsx', 'scripts/foo.mjs'], fixture)).toEqual([HARNESS, WEB]);
  });

  it('runs every check for an APP_CHECK_DRIVERS file', () => {
    for (const file of APP_CHECK_DRIVERS) expect(commandsFor([file], fixture)).toEqual([HARNESS, API, WEB]);
  });

  it('runs every app that reads a shared path', () => {
    expect(commandsFor(['docs/a.md'], fixture)).toEqual([WEB]);
    expect(commandsFor(['package-lock.json'], fixture)).toEqual([HARNESS, API, WEB]);
  });

  it('falls back to the full verify when plan() maps the diff to nothing', () => {
    expect(commandsFor(['README.md'], fixture)).toEqual([FULL]);
    expect(commandsFor([], fixture)).toEqual([FULL]);
    expect(FULL).toBe('npm run verify');
  });
});

describe('unionChanged', () => {
  it('unions the committed diff with modified, untracked and renamed working-tree files', () => {
    const diff = 'scripts/a.mjs\0apps/api/x.py\0';
    const status = ' M apps/web/src/a.tsx\0?? docs/new.md\0R  apps/api/new.py\0apps/api/old.py\0 M scripts/a.mjs\0';
    expect(unionChanged(diff, status).sort()).toEqual(
      ['apps/api/new.py', 'apps/api/old.py', 'apps/api/x.py', 'apps/web/src/a.tsx', 'docs/new.md', 'scripts/a.mjs'].sort(),
    );
  });

  it('plans the app that only has uncommitted work', () => {
    expect(commandsFor(unionChanged('scripts/a.mjs\0', ' M apps/web/src/a.tsx\0'), fixture)).toEqual([HARNESS, WEB]);
  });

  it('plans the web checks for a non-ASCII path in a NUL-separated diff', () => {
    const diff = 'scripts/a.mjs\0apps/web/src/caf\u00e9.tsx\0';
    expect(unionChanged(diff, '')).toContain('apps/web/src/caf\u00e9.tsx');
    expect(commandsFor(unionChanged(diff, ''), fixture)).toEqual([HARNESS, WEB]);
  });

  it('throws on a quoted path, so planFrom runs the full verify', () => {
    const diff = '"apps/web/src/caf\\303\\251.tsx"\0';
    expect(() => unionChanged(diff, '')).toThrow(/quoted/);
    expect(planFrom(() => unionChanged(diff, ''), fixture).commands).toEqual([FULL]);
  });

  it('is empty when nothing changed', () => {
    expect(unionChanged('', '')).toEqual([]);
  });
});

describe('planFrom', () => {
  it('falls back to the full verify with a warning when listing changed files throws', () => {
    const { commands, warning } = planFrom(() => {
      throw new Error("fatal: bad revision 'origin/develop...HEAD'\nmore");
    }, fixture);
    expect(commands).toEqual([FULL]);
    expect(warning).toContain("bad revision 'origin/develop...HEAD'");
    expect(warning).not.toContain('\n');
  });

  it('plans normally, without a warning, when listing works', () => {
    expect(planFrom(() => ['apps/api/x.py'], fixture)).toEqual({ commands: [API], warning: null });
  });
});

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

  it('exposes verify:changed as an npm script', () => {
    expect(JSON.parse(read('package.json')).scripts['verify:changed']).toBe('node scripts/verify-changed.mjs');
  });

  it('leaves CI running the full verify', () => {
    expect(read('.github/workflows/verify.yml')).toMatch(/npm run verify(\s|$)/);
    expect(read('.github/workflows/verify.yml')).not.toContain('verify:changed');
  });

  it('points ship and the implementer at verify:changed with the three-attempt ceiling', () => {
    expect(read('.claude/commands/ship.md')).toContain('npm run verify:changed');
    expect(read('.claude/commands/ship.md')).toMatch(/at most\s+three attempts/);
    expect(read('.claude/agents/implementer.md')).toContain('npm run verify:changed');
    expect(read('.claude/agents/implementer.md')).toMatch(/Three attempts/);
  });
});
