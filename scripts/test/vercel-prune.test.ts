import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KEEP_PRODUCTION,
  MAX_PAGES,
  isPreview,
  listDeployments,
  main,
  prune,
  pruneHistory,
  select,
  selectHistory,
  type Deployment,
  type FetchJson,
} from '../deploy/vercel/vercel-prune.mjs';

const preview = (uid: string, ref: string): Deployment => ({ uid, target: null, meta: { githubCommitRef: ref } });

describe('isPreview', () => {
  it('never lets a production deployment through', () => {
    expect(isPreview({ uid: 'p', target: 'production', meta: { githubCommitRef: 'feat/x' } })).toBe(false);
  });

  it('never lets a develop build through, even one not marked production', () => {
    expect(isPreview(preview('d', 'develop'))).toBe(false);
  });

  it('never lets a deployment with no branch through', () => {
    expect(isPreview({ uid: 'cli', target: null, meta: {} })).toBe(false);
    expect(isPreview({ uid: 'cli', target: null })).toBe(false);
  });

  it('lets a branch preview through', () => {
    expect(isPreview(preview('a', 'feat/x'))).toBe(true);
  });
});

describe('select', () => {
  const all = [
    preview('a', 'feat/x'),
    preview('b', 'feat/y'),
    preview('c', 'develop'),
    { uid: 'p', target: 'production', meta: { githubCommitRef: 'feat/x' } },
  ];
  const ids = (ds: Deployment[]) => ds.map((d) => d.uid);

  it("selects only the closed branch's previews", () => {
    expect(ids(select(all, { branch: 'feat/x' }))).toEqual(['a']);
  });

  it('selects previews of branches that no longer exist, keeping live ones', () => {
    expect(ids(select(all, { live: new Set(['feat/y', 'develop']) }))).toEqual(['a']);
  });

  it('cannot be talked into selecting develop or production by the rule', () => {
    expect(ids(select(all, { branch: 'develop' }))).toEqual([]);
    expect(ids(select(all, { live: new Set() }))).toEqual(['a', 'b']);
  });
});

describe('listDeployments', () => {
  it('follows pagination until Vercel stops returning a next cursor', async () => {
    const urls: string[] = [];
    const pages = [
      { deployments: [preview('a', 'x')], pagination: { next: 111 } },
      { deployments: [preview('b', 'x')], pagination: { next: null } },
    ];
    const fetchJson: FetchJson = async (url) => {
      urls.push(url);
      return pages[urls.length - 1]!;
    };
    const result = await listDeployments(fetchJson, 'thing-front', 'x');
    expect(result.map((d) => d.uid)).toEqual(['a', 'b']);
    expect(urls[0]).toContain('branch=x');
    expect(urls[1]).toContain('until=111');
  });

  it('stops at the page ceiling and says so, rather than looping', async () => {
    let calls = 0;
    const fetchJson: FetchJson = async () => {
      calls++;
      return { deployments: [], pagination: { next: calls } };
    };
    await expect(listDeployments(fetchJson, 'thing-back')).rejects.toThrow(/more than 20 pages/);
    expect(calls).toBe(MAX_PAGES);
  });
});

describe('main', () => {
  it('refuses to run without a token', async () => {
    await expect(main(['branch', 'x'], {})).rejects.toThrow(/VERCEL_TOKEN/);
  });

  it('refuses an empty live-branch list, which would mark every preview stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-prune-'));
    const file = join(dir, 'live.txt');
    writeFileSync(file, '\n\n');
    try {
      await expect(main(['stale', file], { VERCEL_TOKEN: 't' })).rejects.toThrow(/no live branches/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a mode it does not know', async () => {
    await expect(main(['everything'], { VERCEL_TOKEN: 't' })).rejects.toThrow(/usage/);
  });
});

describe('prune', () => {
  // Fixture projects, not project.json's: this tests the pruning, whatever
  // the application is.
  const projects = ['thing-front', 'thing-back'];
  const fetchJson: FetchJson = async (url) => ({
    deployments: url.includes('thing-front')
      ? [preview('w1', 'gone'), preview('w2', 'live'), { id: 'w3', target: null, meta: { githubCommitRef: 'gone' } }]
      : [preview('a1', 'gone'), { uid: 'a2', target: 'production', meta: { githubCommitRef: 'develop' } }],
    pagination: { next: null },
  });

  it('deletes the selected previews in both projects, by uid or id', async () => {
    const removed: string[] = [];
    const deleted = await prune({
      fetchJson,
      remove: async (id) => removed.push(id),
      rule: { live: new Set(['live']) },
      log: () => {},
      projects,
    });
    expect(removed).toEqual(['w1', 'w3', 'a1']);
    expect(deleted.map((d) => `${d.project}:${d.id}`)).toEqual([
      'thing-front:w1',
      'thing-front:w3',
      'thing-back:a1',
    ]);
  });

  it('deletes nothing on a dry run, but reports what it would', async () => {
    const removed: string[] = [];
    const lines: string[] = [];
    const deleted = await prune({
      fetchJson,
      remove: async (id) => removed.push(id),
      rule: { live: new Set(['live']) },
      dryRun: true,
      log: (line) => lines.push(line),
      projects,
    });
    expect(removed).toEqual([]);
    expect(deleted).toHaveLength(3);
    expect(lines[0]).toBe('would delete thing-front w1 (gone)');
  });
});

// Production history: one deployment per merge, kept forever on this plan.
const prod = (id: string, created: number, state = 'READY'): Deployment => ({
  uid: id,
  target: 'production',
  state,
  created,
  meta: { githubCommitRef: 'develop', githubCommitSha: `sha${id}` },
});
const ids = (ds: Deployment[]) => ds.map((d) => d.uid).sort();

describe('selectHistory', () => {
  // Newest first by created: p9 is live.
  const history = [
    prod('p9', 900),
    prod('c8', 800, 'CANCELED'),
    prod('p7', 700),
    prod('p6', 600),
    prod('e5', 500, 'ERROR'),
    prod('p4', 400),
    prod('p3', 300),
    prod('p2', 200),
  ];

  it('keeps the live deployment and the newest built ones, and removes the rest', () => {
    // Kept: p9 (live), p7, p6 — three built. Gone: older built, and every
    // cancelled or failed record, which never served anything.
    expect(ids(selectHistory(history, { liveId: 'p9', keep: 3 }))).toEqual(['c8', 'e5', 'p2', 'p3', 'p4']);
  });

  it('keeps three built deployments by default', () => {
    expect(KEEP_PRODUCTION).toBe(3);
    expect(selectHistory(history, { liveId: 'p9' })).toHaveLength(5);
  });

  it('never removes a built deployment newer than the live one: history ahead of a rollback', () => {
    // Rolled back to p6: p9 and p7 are built and newer than what is serving.
    const doomed = ids(selectHistory(history, { liveId: 'p6', keep: 1 }));
    for (const newer of ['p9', 'p7']) expect(doomed).not.toContain(newer);
    expect(doomed).not.toContain('p6');
  });

  it('removes cancelled records newer than the live one, which never built anything', () => {
    // What the API can look like: live bf4, then several merges the
    // ignore step skipped, each leaving a cancelled production record.
    const skipped = [
      prod('c4', 1000, 'CANCELED'),
      prod('c3', 990, 'CANCELED'),
      prod('e2', 980, 'ERROR'),
      prod('live', 900),
      prod('old', 800),
    ];
    expect(ids(selectHistory(skipped, { liveId: 'live', keep: 2 }))).toEqual(['c3', 'c4', 'e2']);
  });

  it('never removes a build still in flight', () => {
    const building = [prod('p9', 900), prod('b1', 100, 'BUILDING'), prod('q1', 50, 'QUEUED')];
    expect(selectHistory(building, { liveId: 'p9', keep: 1 })).toEqual([]);
  });

  it('never touches a preview, whatever the list contains', () => {
    const mixed = [prod('p9', 900), { ...prod('x1', 10), target: null }];
    expect(ids(selectHistory(mixed, { liveId: 'p9', keep: 1 }))).toEqual([]);
  });

  it('deletes nothing when it cannot see the live deployment', () => {
    expect(() => selectHistory(history, { liveId: undefined })).toThrow(/no live deployment/);
    expect(() => selectHistory(history, { liveId: 'nope' })).toThrow(/not among the production deployments/);
    expect(() => selectHistory(history, { liveId: 'p9', keep: 0 })).toThrow(/keep/);
  });
});

describe('pruneHistory', () => {
  const targets = [{ project: 'thing-front', host: 'front.example.app' }];
  const answers = (liveId: string | undefined): FetchJson => async (url) => {
    if (url.includes('/v4/aliases/')) return { deployments: [], deploymentId: liveId };
    return { deployments: [prod('p3', 300), prod('p2', 200), prod('p1', 100, 'CANCELED')], pagination: { next: null } };
  };

  it("finds the live deployment from the app's alias and asks only for production", async () => {
    const urls: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      urls.push(url);
      return answers('p3')(url);
    };
    const removed: string[] = [];
    await pruneHistory({ fetchJson, remove: async (id) => removed.push(id), targets, keep: 1, log: () => {} });
    expect(urls[0]).toContain('/v4/aliases/front.example.app');
    expect(urls[1]).toContain('target=production');
    expect(removed.sort()).toEqual(['p1', 'p2']);
  });

  it('deletes nothing from any app when one app of several cannot find its live deployment', async () => {
    // The first app's history must not go if the second's alias lookup then
    // fails.
    const two = [
      { project: 'thing-back', host: 'back.example.app' },
      { project: 'thing-front', host: 'front.example.app' },
    ];
    const fetchJson: FetchJson = async (url) => {
      if (url.includes('/v4/aliases/back.example.app')) return { deployments: [], deploymentId: 'p3' };
      if (url.includes('/v4/aliases/')) return { deployments: [] }; // no deploymentId
      return { deployments: [prod('p3', 300), prod('p2', 200), prod('p1', 100, 'CANCELED')], pagination: { next: null } };
    };
    const removed: string[] = [];
    await expect(
      pruneHistory({ fetchJson, remove: async (id) => removed.push(id), targets: two, keep: 1, log: () => {} }),
    ).rejects.toThrow(/no live deployment/);
    expect(removed).toEqual([]);
  });

  it('deletes nothing on a dry run, and nothing at all when the alias names no deployment', async () => {
    const removed: string[] = [];
    const dry = await pruneHistory({ fetchJson: answers('p3'), remove: async (id) => removed.push(id), targets, keep: 1, dryRun: true, log: () => {} });
    expect(dry).toHaveLength(2);
    await expect(
      pruneHistory({ fetchJson: answers(undefined), remove: async (id) => removed.push(id), targets, keep: 1, log: () => {} }),
    ).rejects.toThrow(/no live deployment/);
    expect(removed).toEqual([]);
  });
});
