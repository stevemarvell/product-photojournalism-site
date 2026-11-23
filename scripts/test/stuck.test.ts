import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_MERGES_BEHIND,
  MAX_PR_PAGES,
  PR_PAGE_SIZE,
  aheadCount,
  allPullRequests,
  behindMergeCount,
  find,
  gh,
  git,
  isEmpty,
  localBranches,
  mergedWorktrees,
  noChecksRegistered,
  openPullRequestDetail,
  orphanedBranches,
  parseWorktreeList,
  remoteBranches,
  render,
  renderFindings,
  staleOrConflicting,
  untrackedWorktreeFolders,
  worktreeList,
  type PullRequest,
  type Run,
} from '../stuck.mjs';

const pr = (overrides: Partial<PullRequest>): PullRequest => ({
  number: 1,
  title: 'a pull request',
  state: 'OPEN',
  headRefName: 'feat/x',
  ...overrides,
});

const emptyFindings = () => ({
  orphanedBranches: [],
  untrackedWorktrees: [],
  mergedWorktrees: [],
  staleOrConflicting: [],
  noChecksRegistered: [],
});

describe('localBranches / remoteBranches', () => {
  it('parses one name per line and drops blanks', async () => {
    const run: Run = async () => ({ status: 0, stdout: 'develop\nfeat/x\n\n', stderr: '' });
    expect(await localBranches(run)).toEqual(['develop', 'feat/x']);
  });

  it('strips the origin/ prefix and excludes origin/HEAD', async () => {
    const run: Run = async () => ({ status: 0, stdout: 'origin/develop\norigin/feat/x\norigin/HEAD\n', stderr: '' });
    expect(await remoteBranches(run)).toEqual(['develop', 'feat/x']);
  });

  it('throws with the injected stderr when git fails', async () => {
    const run: Run = async () => ({ status: 1, stdout: '', stderr: 'not a git repository' });
    await expect(localBranches(run)).rejects.toThrow(/not a git repository/);
    await expect(remoteBranches(run)).rejects.toThrow(/not a git repository/);
  });
});

describe('aheadCount / behindMergeCount', () => {
  it('parses the count git prints', async () => {
    const run: Run = async () => ({ status: 0, stdout: '3\n', stderr: '' });
    expect(await aheadCount(run, 'origin/develop', 'feat/x')).toBe(3);
    expect(await behindMergeCount(run, 'origin/develop', 'feat/x')).toBe(3);
  });

  it('is null, not a guess, when the ref cannot be resolved', async () => {
    const run: Run = async () => ({ status: 128, stdout: '', stderr: "unknown revision 'feat/gone'" });
    expect(await aheadCount(run, 'origin/develop', 'feat/gone')).toBeNull();
    expect(await behindMergeCount(run, 'origin/develop', 'feat/gone')).toBeNull();
  });
});

describe('parseWorktreeList', () => {
  it('parses worktree/branch pairs, including a detached one with no branch line', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/develop',
      '',
      'worktree /repo/.claude/worktrees/agent-1',
      'HEAD def456',
      'branch refs/heads/feat/x',
      '',
      'worktree /repo/.claude/worktrees/detached',
      'HEAD abc123',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repo', branch: 'develop', head: 'abc123' },
      { path: '/repo/.claude/worktrees/agent-1', branch: 'feat/x', head: 'def456' },
      { path: '/repo/.claude/worktrees/detached', branch: null, head: 'abc123' },
    ]);
  });
});

describe('worktreeList', () => {
  it('throws with the injected stderr when git fails', async () => {
    const run: Run = async () => ({ status: 1, stdout: '', stderr: 'no worktrees' });
    await expect(worktreeList(run)).rejects.toThrow(/no worktrees/);
  });
});

describe('allPullRequests', () => {
  const rest = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: `pull request ${number}`,
    state: 'open',
    merged_at: null,
    head: { ref: `feat/${number}`, sha: `sha${number}` },
    ...extra,
  });
  const page = (n: number, from = 1) => Array.from({ length: n }, (_, i) => rest(from + i));

  it('reads REST, never gh pr list (GraphQL, refused from cloud sessions), asking for every state', async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify([rest(7)]), stderr: '' };
    };
    await allPullRequests(run);
    expect(calls[0]![0]).toBe('api');
    expect(calls[0]![1]).toContain('repos/{owner}/{repo}/pulls?state=all');
    expect(calls.flat()).not.toContain('pr');
  });

  it('maps REST state onto OPEN, MERGED and CLOSED, telling merged from closed by merged_at', async () => {
    const run: Run = async () => ({
      status: 0,
      stdout: JSON.stringify([
        rest(1),
        rest(2, { state: 'closed', merged_at: '2026-10-01T00:00:00Z' }),
        rest(3, { state: 'closed' }),
      ]),
      stderr: '',
    });
    expect(await allPullRequests(run)).toEqual([
      { number: 1, title: 'pull request 1', state: 'OPEN', headRefName: 'feat/1', headRefOid: 'sha1' },
      { number: 2, title: 'pull request 2', state: 'MERGED', headRefName: 'feat/2', headRefOid: 'sha2' },
      { number: 3, title: 'pull request 3', state: 'CLOSED', headRefName: 'feat/3', headRefOid: 'sha3' },
    ]);
  });

  it('follows pages until a short one', async () => {
    const pages = [page(PR_PAGE_SIZE), page(3, PR_PAGE_SIZE + 1)];
    const routes: string[] = [];
    const run: Run = async (args) => {
      routes.push(args[1]!);
      return { status: 0, stdout: JSON.stringify(pages[routes.length - 1]), stderr: '' };
    };
    expect(await allPullRequests(run)).toHaveLength(PR_PAGE_SIZE + 3);
    expect(routes.map((r) => r.slice(-6))).toEqual(['page=1', 'page=2']);
  });

  it('throws with the injected stderr on failure', async () => {
    const run: Run = async () => ({ status: 1, stdout: '', stderr: 'HTTP 401' });
    await expect(allPullRequests(run)).rejects.toThrow(/HTTP 401/);
  });

  it('fails loudly rather than returning a silently truncated list when it runs out of pages', async () => {
    let calls = 0;
    const run: Run = async () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify(page(PR_PAGE_SIZE, calls * 1000)), stderr: '' };
    };
    await expect(allPullRequests(run, 3)).rejects.toThrow(/truncated/);
    expect(calls).toBe(3);
  });

  it('does not throw when the last page is short, however many pages it took', async () => {
    let calls = 0;
    const run: Run = async () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify(calls < 3 ? page(PR_PAGE_SIZE, calls * 1000) : page(4, 9000)), stderr: '' };
    };
    await expect(allPullRequests(run, 3)).resolves.toHaveLength(2 * PR_PAGE_SIZE + 4);
  });

  it('has a page ceiling of 500 pull requests by default, far above this repository\'s count', () => {
    expect(MAX_PR_PAGES * PR_PAGE_SIZE).toBe(500);
  });
});

describe('openPullRequestDetail', () => {
  const open = pr({ number: 5, headRefOid: 'abc123' });
  const noSleep = async () => {};

  function runWith(answers: Record<string, string[]>): { run: Run; routes: string[] } {
    const routes: string[] = [];
    const remaining = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]));
    const run: Run = async (args) => {
      routes.push(args[1]!);
      const key = Object.keys(remaining).find((k) => args[1]!.endsWith(k));
      if (!key) return { status: 1, stdout: '', stderr: `unexpected route ${args[1]}` };
      const next = remaining[key]!.length > 1 ? remaining[key]!.shift()! : remaining[key]![0]!;
      return { status: 0, stdout: `${next}\n`, stderr: '' };
    };
    return { run, routes };
  }

  it('maps REST mergeable true/false onto MERGEABLE/CONFLICTING, and sums check runs and statuses', async () => {
    const { run, routes } = runWith({ '/pulls/5': ['true'], '/check-runs': ['4'], '/status': ['1'] });
    expect(await openPullRequestDetail(run, open, { sleep: noSleep })).toEqual({ mergeable: 'MERGEABLE', checks: 5 });
    expect(routes).toContain('repos/{owner}/{repo}/commits/abc123/check-runs');
    expect(routes).toContain('repos/{owner}/{repo}/commits/abc123/status');
    const conflicting = runWith({ '/pulls/5': ['false'], '/check-runs': ['0'], '/status': ['0'] });
    expect(await openPullRequestDetail(conflicting.run, open, { sleep: noSleep })).toEqual({ mergeable: 'CONFLICTING', checks: 0 });
  });

  it('waits and re-reads while GitHub has not worked mergeable out yet', async () => {
    const { run } = runWith({ '/pulls/5': ['null', 'null', 'true'], '/check-runs': ['1'], '/status': ['0'] });
    const waits: number[] = [];
    const detail = await openPullRequestDetail(run, open, { sleep: async (ms) => void waits.push(ms) });
    expect(detail.mergeable).toBe('MERGEABLE');
    expect(waits).toHaveLength(2);
  });

  it('gives up after its attempts and reports UNKNOWN, rather than waiting on or guessing', async () => {
    const { run, routes } = runWith({ '/pulls/5': ['null'], '/check-runs': ['1'], '/status': ['0'] });
    const waits: number[] = [];
    const detail = await openPullRequestDetail(run, open, { sleep: async (ms) => void waits.push(ms), attempts: 3 });
    expect(detail.mergeable).toBe('UNKNOWN');
    expect(routes.filter((r) => r.endsWith('/pulls/5'))).toHaveLength(3);
    expect(waits).toHaveLength(2);
  });

  it('throws, rather than reporting zero checks, when a call fails', async () => {
    const run: Run = async (args) =>
      args[1]!.endsWith('/status') ? { status: 1, stdout: '', stderr: 'HTTP 502' } : { status: 0, stdout: '1\n', stderr: '' };
    await expect(openPullRequestDetail(run, open, { sleep: noSleep })).rejects.toThrow(/HTTP 502/);
  });
});

describe('orphanedBranches', () => {
  it('reports a branch ahead of develop with no pull request at all, open or closed', () => {
    const result = orphanedBranches(
      { local: [{ name: 'feat/orphan', ahead: 2 }] },
      [pr({ headRefName: 'feat/other', state: 'CLOSED' })],
    );
    expect(result).toEqual([{ name: 'feat/orphan', ahead: 2, where: 'local' }]);
  });

  it('is not fooled by a closed pull request: a branch with any PR at all is not orphaned', () => {
    const result = orphanedBranches(
      { local: [{ name: 'feat/x', ahead: 2 }] },
      [pr({ headRefName: 'feat/x', state: 'CLOSED' })],
    );
    expect(result).toEqual([]);
  });

  it('never reports a branch with nothing ahead of develop', () => {
    expect(orphanedBranches({ local: [{ name: 'develop', ahead: 0 }] }, [])).toEqual([]);
  });

  it('never reports a branch whose ahead count is unknown', () => {
    expect(orphanedBranches({ local: [{ name: 'feat/gone', ahead: null }] }, [])).toEqual([]);
  });

  it('reports a branch present both locally and remotely once, naming both', () => {
    const result = orphanedBranches(
      { local: [{ name: 'feat/x', ahead: 1 }], remote: [{ name: 'feat/x', ahead: 3 }] },
      [],
    );
    expect(result).toEqual([{ name: 'feat/x', ahead: 3, where: 'local and remote' }]);
  });

  it('sorts by name', () => {
    const result = orphanedBranches(
      { local: [{ name: 'zeta', ahead: 1 }, { name: 'alpha', ahead: 1 }] },
      [],
    );
    expect(result.map((b) => b.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('untrackedWorktreeFolders', () => {
  it('reports a folder git worktree list does not track', () => {
    const result = untrackedWorktreeFolders(
      ['agent-1', 'agent-2-leftover'],
      ['/repo/.claude/worktrees/agent-1'],
    );
    expect(result).toEqual(['agent-2-leftover']);
  });

  it('matches on the registered path\'s basename regardless of slash direction', () => {
    const result = untrackedWorktreeFolders(['agent-1'], ['C:\\repo\\.claude\\worktrees\\agent-1']);
    expect(result).toEqual([]);
  });

  it('reports nothing when every folder on disk is registered', () => {
    expect(untrackedWorktreeFolders([], [])).toEqual([]);
  });
});

describe('mergedWorktrees', () => {
  const main = { path: '/repo', branch: 'develop', head: 'dev1' };

  it('reports a linked worktree whose HEAD is the merged pull request head', () => {
    const worktrees = [main, { path: '/repo/.claude/worktrees/agent-1', branch: 'feat/done', head: 'sha42' }];
    const prs = [pr({ number: 42, headRefName: 'feat/done', headRefOid: 'sha42', state: 'MERGED' })];
    expect(mergedWorktrees(worktrees, prs)).toEqual([{ path: '/repo/.claude/worktrees/agent-1', branch: 'feat/done', pr: 42 }]);
  });

  it('never reports the main working tree, whatever its branch (#233)', () => {
    // The main tree is on a branch name that has a merged pull request, and
    // is even at that pull request's head: still the first entry, still skipped.
    const worktrees = [{ path: '/repo', branch: 'feat/reused', head: 'sha229' }];
    const prs = [pr({ number: 229, headRefName: 'feat/reused', headRefOid: 'sha229', state: 'MERGED' })];
    expect(mergedWorktrees(worktrees, prs)).toEqual([]);
  });

  it('does not report a reused branch name whose HEAD is not the merged pull request head (#233)', () => {
    const worktrees = [main, { path: '/repo/.claude/worktrees/agent-1', branch: 'feat/reused', head: 'newwork' }];
    const prs = [pr({ number: 229, headRefName: 'feat/reused', headRefOid: 'sha229', state: 'MERGED' })];
    expect(mergedWorktrees(worktrees, prs)).toEqual([]);
  });

  it('reports a reused branch name when HEAD is the head of any one of its merged pull requests', () => {
    const worktrees = [main, { path: '/repo/.claude/worktrees/agent-1', branch: 'feat/reused', head: 'sha230' }];
    const prs = [
      pr({ number: 229, headRefName: 'feat/reused', headRefOid: 'sha229', state: 'MERGED' }),
      pr({ number: 230, headRefName: 'feat/reused', headRefOid: 'sha230', state: 'MERGED' }),
    ];
    expect(mergedWorktrees(worktrees, prs)).toEqual([{ path: '/repo/.claude/worktrees/agent-1', branch: 'feat/reused', pr: 230 }]);
  });

  it('does not report a worktree whose pull request is still open', () => {
    const worktrees = [main, { path: '/repo/.claude/worktrees/agent-1', branch: 'feat/wip', head: 'sha1' }];
    const prs = [pr({ headRefName: 'feat/wip', headRefOid: 'sha1', state: 'OPEN' })];
    expect(mergedWorktrees(worktrees, prs)).toEqual([]);
  });

  it('does not report a worktree with no recorded HEAD, or a merged pull request with no head SHA', () => {
    const prs = [pr({ headRefName: 'feat/done', state: 'MERGED' })];
    expect(mergedWorktrees([main, { path: '/repo/x', branch: 'feat/done', head: null }], prs)).toEqual([]);
    expect(mergedWorktrees([main, { path: '/repo/x', branch: 'feat/done', head: 'sha1' }], prs)).toEqual([]);
  });

  it('does not report a detached worktree, which has no branch to check', () => {
    expect(mergedWorktrees([main, { path: '/repo/x', branch: null, head: 'sha1' }], [])).toEqual([]);
  });
});

describe('staleOrConflicting', () => {
  it('reports an open PR whose mergeable is CONFLICTING', () => {
    const result = staleOrConflicting([pr({ mergeable: 'CONFLICTING' })]);
    expect(result).toEqual([{ number: 1, title: 'a pull request', reasons: ['mergeable is CONFLICTING'] }]);
  });

  it('reports an open PR whose mergeable is UNKNOWN', () => {
    const result = staleOrConflicting([pr({ mergeable: 'UNKNOWN' })]);
    expect(result[0]!.reasons).toEqual(['mergeable is UNKNOWN']);
  });

  it('does not report a MERGEABLE open PR', () => {
    expect(staleOrConflicting([pr({ mergeable: 'MERGEABLE' })])).toEqual([]);
  });

  it(`reports an open PR more than ${MAX_MERGES_BEHIND} merges behind develop`, () => {
    const behind = new Map([[1, 3]]);
    const result = staleOrConflicting([pr({ mergeable: 'MERGEABLE' })], behind);
    expect(result[0]!.reasons).toEqual(['3 merges behind develop']);
  });

  it(`does not report an open PR exactly ${MAX_MERGES_BEHIND} merges behind`, () => {
    const behind = new Map([[1, MAX_MERGES_BEHIND]]);
    expect(staleOrConflicting([pr({ mergeable: 'MERGEABLE' })], behind)).toEqual([]);
  });

  it('never reports a closed or merged pull request', () => {
    expect(staleOrConflicting([pr({ mergeable: 'CONFLICTING', state: 'CLOSED' })])).toEqual([]);
    expect(staleOrConflicting([pr({ mergeable: 'CONFLICTING', state: 'MERGED' })])).toEqual([]);
  });

  it('treats an unknown behind count as unknown, not as clean or stale', () => {
    const behind = new Map([[1, null]]);
    expect(staleOrConflicting([pr({ mergeable: 'MERGEABLE' })], behind)).toEqual([]);
  });

  it('reports both reasons together when both apply', () => {
    const behind = new Map([[1, 5]]);
    const result = staleOrConflicting([pr({ mergeable: 'CONFLICTING' })], behind);
    expect(result[0]!.reasons).toEqual(['mergeable is CONFLICTING', '5 merges behind develop']);
  });
});

describe('noChecksRegistered', () => {
  it('reports an open PR whose head has no check runs or statuses', () => {
    expect(noChecksRegistered([pr({ checks: 0 })])).toEqual([pr({ checks: 0 })]);
  });

  it('does not report an open PR with at least one check', () => {
    expect(noChecksRegistered([pr({ checks: 1 })])).toEqual([]);
  });

  it('does not report an open PR whose checks are unknown: unknown is not the same as none', () => {
    expect(noChecksRegistered([pr({})])).toEqual([]);
  });

  it('never reports a closed or merged pull request', () => {
    expect(noChecksRegistered([pr({ state: 'CLOSED', checks: 0 })])).toEqual([]);
  });
});

describe('isEmpty', () => {
  it('is true for findings with nothing in any list', () => {
    expect(isEmpty(emptyFindings())).toBe(true);
  });

  it('is false when any one list has an entry', () => {
    expect(isEmpty({ ...emptyFindings(), orphanedBranches: [{ name: 'x', ahead: 1, where: 'local' }] })).toBe(false);
  });
});

describe('render / renderFindings', () => {
  it('says nothing is stuck when every list is empty', () => {
    expect(render(emptyFindings())).toContain('nothing stuck');
    expect(renderFindings(emptyFindings())).toEqual([]);
  });

  it('gives one line per finding, naming a next action', () => {
    const findings = {
      orphanedBranches: [{ name: 'feat/orphan', ahead: 2, where: 'local' }],
      untrackedWorktrees: [{ name: 'agent-leftover', entryCount: 4, hasChanges: true }],
      mergedWorktrees: [{ path: '/repo/.claude/worktrees/agent-1', branch: 'feat/done', pr: 42 }],
      staleOrConflicting: [{ number: 9, title: 'stale', reasons: ['mergeable is CONFLICTING'] }],
      noChecksRegistered: [pr({ number: 10, title: 'no checks', checks: 0 })],
    };
    const lines = renderFindings(findings);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("'feat/orphan'");
    expect(lines[0]).toContain('open one');
    expect(lines[1]).toContain('agent-leftover');
    expect(lines[1]).toContain('4 entries');
    expect(lines[1]).toContain('uncommitted changes');
    expect(lines[2]).toContain('#42');
    expect(lines[2]).toContain('git worktree remove');
    expect(lines[3]).toContain('#9');
    expect(lines[3]).toContain('merge develop into the branch');
    expect(lines[4]).toContain('#10');
    expect(lines[4]).toContain('mergeable_state');
    expect(render(findings).trim().split('\n')).toHaveLength(5);
  });

  it('reports an untracked folder with an unknown git status as unknown, and never suggests removing it', () => {
    const findings = {
      ...emptyFindings(),
      untrackedWorktrees: [{ name: 'agent-leftover', entryCount: 3, hasChanges: null }],
    };
    const [line] = renderFindings(findings);
    expect(line).toContain('agent-leftover');
    expect(line).toContain('3 entries');
    expect(line).toContain('unknown');
    expect(line).toContain('not a git checkout');
    expect(line).not.toContain('remove the folder by hand');
  });

  it('never suggests deleting or removing anything itself: it only reports', () => {
    const findings = {
      orphanedBranches: [{ name: 'feat/orphan', ahead: 2, where: 'local' }],
      untrackedWorktrees: [{ name: 'agent-leftover', entryCount: 0, hasChanges: false }],
      mergedWorktrees: [{ path: '/repo/x', branch: 'feat/done', pr: 1 }],
      staleOrConflicting: [],
      noChecksRegistered: [],
    };
    // Every suggested action is phrased as something a person or a later
    // command does ("open one", "run `git worktree remove`"); this script
    // itself must never call a destructive command to get there.
    expect(renderFindings(findings).join('\n')).not.toMatch(/\bgit branch -D\b|\brm -rf\b/);
  });
});

describe('find', () => {
  it('wires gh, git and filesystem together into one set of findings, with no network calls of its own', async () => {
    const gitCalls: string[][] = [];
    const fakeGit: Run = async (args) => {
      gitCalls.push(args);
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) {
        return { status: 0, stdout: 'develop\nfeat/orphan\n', stderr: '' };
      }
      if (args[0] === 'for-each-ref' && args.includes('refs/remotes/origin')) {
        return { status: 0, stdout: 'origin/develop\n', stderr: '' };
      }
      if (args[0] === 'worktree') {
        return {
          status: 0,
          stdout: [
            'worktree /repo',
            'HEAD dev1',
            'branch refs/heads/feat/merged',
            '',
            'worktree /repo/.claude/worktrees/agent-1',
            'HEAD sha42',
            'branch refs/heads/feat/merged',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'rev-list' && args.includes('--first-parent')) {
        return { status: 0, stdout: '0\n', stderr: '' };
      }
      if (args[0] === 'rev-list') {
        // develop..feat/orphan is ahead by 2; everything else is ahead by 0.
        return { status: 0, stdout: args.join(' ').includes('feat/orphan') ? '2\n' : '0\n', stderr: '' };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const restPr = (number: number, ref: string, extra: Record<string, unknown> = {}) => ({
      number,
      title: 'a pull request',
      state: 'open',
      merged_at: null,
      head: { ref, sha: `sha${number}` },
      ...extra,
    });
    const fakeGh: Run = async (args) => {
      const route = args[1]!;
      if (route.includes('/pulls?')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            restPr(42, 'feat/merged', { state: 'closed', merged_at: '2026-10-01T00:00:00Z' }),
            restPr(43, 'feat/open'),
          ]),
          stderr: '',
        };
      }
      if (route.endsWith('/pulls/43')) return { status: 0, stdout: 'false\n', stderr: '' };
      if (route.endsWith('/commits/sha43/check-runs') || route.endsWith('/commits/sha43/status')) {
        return { status: 0, stdout: '0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected gh route: ${route}` };
    };
    const readDirCalls: string[] = [];
    const readDir = (dir: string) => {
      readDirCalls.push(dir);
      if (dir.endsWith('worktrees')) return ['agent-1', 'agent-leftover'];
      if (dir.endsWith('agent-leftover')) return ['one.txt', 'two.txt'];
      return [];
    };
    const gitStatus = async (dir: string) => dir.endsWith('agent-leftover');

    const findings = await find({ gh: fakeGh, git: fakeGit, readDir, gitStatus, sleep: async () => {} });

    expect(findings.orphanedBranches).toEqual([{ name: 'feat/orphan', ahead: 2, where: 'local' }]);
    expect(findings.untrackedWorktrees).toEqual([{ name: 'agent-leftover', entryCount: 2, hasChanges: true }]);
    expect(findings.mergedWorktrees).toEqual([{ path: '/repo/.claude/worktrees/agent-1', branch: 'feat/merged', pr: 42 }]);
    expect(findings.staleOrConflicting).toEqual([{ number: 43, title: 'a pull request', reasons: ['mergeable is CONFLICTING'] }]);
    expect(findings.noChecksRegistered).toEqual([
      pr({ number: 43, headRefName: 'feat/open', headRefOid: 'sha43', state: 'OPEN', mergeable: 'CONFLICTING', checks: 0 }),
    ]);
    expect(isEmpty(findings)).toBe(false);
    // The per-folder entry count comes from the same injected readDir,
    // called once for the worktrees directory and once per untracked folder.
    expect(readDirCalls.some((dir) => dir.endsWith('agent-leftover'))).toBe(true);
  });

  it('is clean — isEmpty is true — when nothing is found', async () => {
    const fakeGit: Run = async (args) => {
      if (args[0] === 'for-each-ref') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree') return { status: 0, stdout: 'worktree /repo\nbranch refs/heads/develop\n', stderr: '' };
      return { status: 0, stdout: '0\n', stderr: '' };
    };
    const fakeGh: Run = async () => ({ status: 0, stdout: '[]', stderr: '' });
    const findings = await find({ gh: fakeGh, git: fakeGit, readDir: () => [], gitStatus: async () => false });
    expect(isEmpty(findings)).toBe(true);
  });

  it('keeps an untracked folder\'s git status as unknown end to end, when `git status` itself fails there', async () => {
    const fakeGit: Run = async (args) => {
      if (args[0] === 'for-each-ref') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree') return { status: 0, stdout: 'worktree /repo\nbranch refs/heads/develop\n', stderr: '' };
      return { status: 0, stdout: '0\n', stderr: '' };
    };
    const fakeGh: Run = async () => ({ status: 0, stdout: '[]', stderr: '' });
    const readDir = (dir: string) => (dir.endsWith('worktrees') ? ['not-a-checkout'] : ['one.txt']);
    // The real default `gitStatus` returns null exactly when `git status`
    // itself fails — simulated here directly, the way a folder `git
    // worktree list` no longer tracks is the likely real-world case.
    const gitStatus = async () => null;
    const findings = await find({ gh: fakeGh, git: fakeGit, readDir, gitStatus });
    expect(findings.untrackedWorktrees).toEqual([{ name: 'not-a-checkout', entryCount: 1, hasChanges: null }]);
  });
});

describe('find: a plain file in .claude/worktrees (#414)', () => {
  const fakeGit: Run = async (args) => {
    if (args[0] === 'for-each-ref') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'worktree') return { status: 0, stdout: 'worktree /repo\nbranch refs/heads/develop\n', stderr: '' };
    return { status: 0, stdout: '0\n', stderr: '' };
  };
  const fakeGh: Run = async () => ({ status: 0, stdout: '[]', stderr: '' });

  it('reports the file as a stray file and does not crash scanning it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stuck-worktrees-'));
    try {
      mkdirSync(join(dir, 'agent-leftover'));
      writeFileSync(join(dir, 'agent-leftover', 'one.txt'), 'x');
      writeFileSync(join(dir, 'w.patch'), 'diff');
      const findings = await find({ gh: fakeGh, git: fakeGit, worktreesDir: dir, gitStatus: async () => false });
      expect(findings.strayFiles).toEqual(['.claude/worktrees/w.patch']);
      expect(findings.untrackedWorktrees).toEqual([{ name: 'agent-leftover', entryCount: 1, hasChanges: false }]);
      expect(renderFindings(findings).join('\n')).toContain('(1 entry,');
      expect(isEmpty(findings)).toBe(false);
      expect(renderFindings(findings)).toContain('stray file: .claude/worktrees/w.patch — delete it.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a symlink to a file, and a dangling symlink, as stray too, and still scans a symlink to a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stuck-worktrees-'));
    const target = mkdtempSync(join(tmpdir(), 'stuck-target-'));
    try {
      writeFileSync(join(target, 'real.txt'), 'x');
      symlinkSync(join(target, 'real.txt'), join(dir, 'link.patch'));
      symlinkSync(join(target, 'missing'), join(dir, 'dangling'));
      symlinkSync(target, join(dir, 'linked-dir'));
      const findings = await find({ gh: fakeGh, git: fakeGit, worktreesDir: dir, gitStatus: async () => false });
      expect([...findings.strayFiles!].sort()).toEqual(['.claude/worktrees/dangling', '.claude/worktrees/link.patch']);
      expect(findings.untrackedWorktrees.map((w: { name: string }) => w.name)).toEqual(['linked-dir']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('is unchanged when the folder holds only directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stuck-worktrees-'));
    try {
      mkdirSync(join(dir, 'agent-leftover'));
      const findings = await find({ gh: fakeGh, git: fakeGit, worktreesDir: dir, gitStatus: async () => false });
      expect(findings.strayFiles).toEqual([]);
      expect(renderFindings(findings)).toHaveLength(1);
      expect(renderFindings(findings)[0]).toContain('untracked worktree folder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gh / git', () => {
  // Timeout: spawns the real gh and git binaries, each failing on a bad flag (<=100 ms quiet); 15 s.
  it('reports a real failure, for an invocation that is safe offline', { timeout: 15_000 }, async () => {
    const ghResult = await gh(['api', '--bogus-flag']);
    expect(ghResult.status).not.toBe(0);

    const gitResult = await git(['for-each-ref', '--bogus-flag']);
    expect(gitResult.status).not.toBe(0);
  });
});
