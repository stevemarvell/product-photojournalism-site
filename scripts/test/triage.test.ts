import { describe, expect, it } from 'vitest';
import {
  FETCH_LIMIT,
  MAX_ISSUES_PER_RUN,
  MAX_PAGES,
  PAGE_SIZE,
  claimedIssues,
  fetchOpen,
  openDependencies,
  render,
  triage,
} from '../triage.mjs';

const issue = (number: number, labels: string[], body = '') => ({
  number,
  title: `issue ${number}`,
  labels,
  body,
});

describe('triage', () => {
  it('orders by rank, security first within a rank, then oldest first', () => {
    const { work } = triage(
      [
        issue(5, ['medium']),
        issue(4, ['high']),
        issue(3, ['medium', 'security']),
        issue(2, []),
        issue(1, ['medium']),
        issue(6, ['critical']),
      ],
      [],
      Infinity,
    );
    expect(work.map((w) => w.number)).toEqual([6, 4, 3, 1, 5, 2]);
    expect(work.map((w) => w.rank)).toEqual(['critical', 'high', 'medium', 'medium', 'medium', 'unranked']);
  });

  it('skips anything a person owns, whichever label says so', () => {
    const { work, skip } = triage(
      [
        issue(1, ['medium', 'human']),
        issue(2, ['do not automate']),
        issue(3, ['blocked: no paid plan']),
        issue(4, ['medium']),
      ],
      [],
    );
    expect(work.map((w) => w.number)).toEqual([4]);
    expect(skip.map((s) => s.number)).toEqual([1, 2, 3]);
    expect(skip[0]!.reason).toBe('needs a person (human)');
  });

  it('skips a template, which is a scaffold for a person to copy, never work to do', () => {
    const { work, skip } = triage([issue(1, ['template']), issue(2, [])], []);
    expect(work.map((w) => w.number)).toEqual([2]);
    expect(skip).toEqual([{ number: 1, title: 'issue 1', reason: 'a template, copied by a person' }]);
  });

  it('skips an issue an open pull request already claims', () => {
    const { work, skip } = triage([issue(7, ['high']), issue(8, ['medium'])], [
      { number: 99, body: 'Some text.\n\nCloses #7' },
    ]);
    expect(work.map((w) => w.number)).toEqual([8]);
    expect(skip).toEqual([{ number: 7, title: 'issue 7', reason: 'in flight in #99' }]);
  });

  it('skips an issue that depends on one still open, and not on one that is closed', () => {
    const { work, skip } = triage(
      [issue(10, ['medium'], 'Depends on #11.'), issue(11, ['medium']), issue(12, ['medium'], 'Depends on #3.')],
      [],
    );
    expect(work.map((w) => w.number)).toEqual([11, 12]);
    expect(skip[0]!.reason).toBe('depends on open #11');
  });

  it('ranks a label named like an Object.prototype property as unranked, not NaN', () => {
    const { work } = triage(
      [issue(1, ['constructor']), issue(2, ['medium']), issue(3, ['toString', 'high'])],
      [],
    );
    expect(work.map((w) => w.number)).toEqual([3, 2, 1]);
    expect(work.map((w) => w.rank)).toEqual(['high', 'medium', 'unranked']);
  });

  it('works nothing when everything is skipped, rather than failing', () => {
    expect(triage([issue(1, ['human'])], []).work).toEqual([]);
    expect(triage([], []).work).toEqual([]);
  });
});

describe('the per-run ceiling', () => {
  const many = [1, 2, 3, 4, 5].map((n) => issue(n, ['medium']));

  it('takes at most MAX_ISSUES_PER_RUN, the highest ranked first', () => {
    const { work } = triage([...many, issue(9, ['critical'])], []);
    expect(work).toHaveLength(MAX_ISSUES_PER_RUN);
    expect(work[0]!.number).toBe(9);
  });

  it('defers the rest in order rather than dropping them', () => {
    const { work, deferred } = triage(many, []);
    expect([...work, ...deferred].map((w) => w.number)).toEqual([1, 2, 3, 4, 5]);
    expect(deferred.map((d) => d.number)).toEqual([4, 5]);
  });

  it('is three, the number docs/sops.md declares', () => {
    expect(MAX_ISSUES_PER_RUN).toBe(3);
  });
});

describe('render', () => {
  it('says when there is nothing to work, rather than printing an empty list', () => {
    expect(render(triage([issue(1, ['human'])], []))).toContain('nothing an agent may take on');
  });

  it('lists deferred work and warns when a listing was truncated', () => {
    const text = render(triage([1, 2, 3, 4].map((n) => issue(n, ['medium'])), []), { truncated: true });
    expect(text).toContain('Deferred to the next run');
    expect(text).toContain('#4 [medium]');
    expect(text).toContain('WARNING');
  });
});

describe('claimedIssues', () => {
  it('reads every closing and referencing keyword, case-insensitively', () => {
    const claimed = claimedIssues([
      { number: 1, body: 'closes #10, Fixes #11' },
      { number: 2, body: 'RESOLVES #12\nRefs #13' },
      { number: 3, body: 'mentions #14 in passing' },
    ]);
    expect([...claimed.entries()]).toEqual([
      [10, 1],
      [11, 1],
      [12, 2],
      [13, 2],
    ]);
  });
});

describe('openDependencies', () => {
  it('returns only the dependencies still open', () => {
    expect(openDependencies(issue(1, [], 'Depends on #2 and depends on #3'), new Set([2]))).toEqual([2]);
  });
});

describe('fetchOpen', () => {
  const rest = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: `item ${number}`,
    body: `body ${number}`,
    labels: [{ name: 'high' }],
    ...extra,
  });

  it('reads REST, never a GraphQL-backed subcommand, and splits issues from pull requests', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return JSON.stringify([rest(1), rest(2, { pull_request: {}, body: 'Closes #1' })]);
    };
    const { issues, pullRequests, truncated } = fetchOpen(run);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('api');
    expect(calls[0]![1]).toMatch(/^repos\/\{owner\}\/\{repo\}\/issues\?state=open&per_page=100&page=1$/);
    expect(issues).toEqual([{ number: 1, title: 'item 1', body: 'body 1', labels: ['high'] }]);
    expect(pullRequests).toEqual([{ number: 2, body: 'Closes #1' }]);
    expect(truncated).toBe(false);
  });

  it('feeds triage: an issue a listed pull request closes is in flight', () => {
    const run = () => JSON.stringify([rest(1), rest(2, { pull_request: {}, body: 'Closes #1' })]);
    const { issues, pullRequests } = fetchOpen(run);
    expect(triage(issues, pullRequests).skip).toEqual([{ number: 1, title: 'item 1', reason: 'in flight in #2' }]);
  });

  it('follows pages until a short one', () => {
    const pages = [
      Array.from({ length: PAGE_SIZE }, (_, i) => rest(i + 1)),
      [rest(PAGE_SIZE + 1)],
    ];
    const seen: string[] = [];
    const run = (args: string[]) => {
      seen.push(args[1]!);
      return JSON.stringify(pages[seen.length - 1]);
    };
    const { issues, truncated } = fetchOpen(run);
    expect(issues).toHaveLength(PAGE_SIZE + 1);
    expect(seen.map((r) => r.slice(-6))).toEqual(['page=1', 'page=2']);
    expect(truncated).toBe(false);
  });

  const fullPage = (from: number) => JSON.stringify(Array.from({ length: PAGE_SIZE }, (_, i) => rest(from + i)));

  it('stops at its page ceiling and says the listing was truncated when an item lies beyond it', () => {
    const routes: string[] = [];
    const run = (args: string[]) => {
      routes.push(args[1]!);
      // The probe past the ceiling asks for one item and finds one.
      return args[1]!.includes('per_page=1&') ? JSON.stringify([rest(99999)]) : fullPage(routes.length * 1000);
    };
    const { issues, truncated } = fetchOpen(run);
    expect(routes).toHaveLength(MAX_PAGES + 1);
    expect(routes.at(-1)).toBe(`repos/{owner}/{repo}/issues?state=open&per_page=1&page=${FETCH_LIMIT + 1}`);
    expect(issues).toHaveLength(FETCH_LIMIT);
    expect(truncated).toBe(true);
    expect(render(triage(issues, []), { truncated })).toContain('WARNING');
  });

  it('is not truncated when the ceiling page is full but nothing lies beyond it', () => {
    let calls = 0;
    const run = (args: string[]) => {
      calls += 1;
      return args[1]!.includes('per_page=1&') ? '[]' : fullPage(calls * 1000);
    };
    const { issues, truncated } = fetchOpen(run);
    expect(calls).toBe(MAX_PAGES + 1);
    expect(issues).toHaveLength(FETCH_LIMIT);
    expect(truncated).toBe(false);
  });

  it('lets a failure from gh through, rather than planning from nothing', () => {
    const run = () => {
      throw new Error('gh api failed: HTTP 403');
    };
    expect(() => fetchOpen(run)).toThrow(/HTTP 403/);
  });
});
