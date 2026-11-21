import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FETCH_LIMIT,
  MAX_ISSUES_PER_RUN,
  MAX_PAGES,
  PAGE_SIZE,
  claimedIssues,
  fetchOpen,
  openDependencies,
  permissionLookup,
  render,
  readiness,
  triage,
  trusted,
} from '../triage.mjs';

const OWNER = 'owner';
const READY = '## Acceptance criteria\n\n- **Given** a\n- **Then** b\n\n## Details to complete\n\nNone\n';
const issue = (number: number, labels: string[], body = READY, login = OWNER, association = 'OWNER') => ({
  number,
  title: `issue ${number}`,
  labels,
  body,
  user: { login },
  authorAssociation: association,
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
      [issue(10, ['medium'], `${READY}Depends on #11.`), issue(11, ['medium']), issue(12, ['medium'], `${READY}Depends on #3.`)],
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
    user: { login: 'someone' },
    author_association: 'OWNER',
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
    expect(issues).toEqual([{ number: 1, title: 'item 1', body: 'body 1', user: { login: 'someone' }, authorAssociation: 'OWNER', labels: ['high'] }]);
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

describe('trusted: only text written by the owner or someone with write access', () => {
  const held = (association: string, labels: string[] = []) => ({
    number: 1,
    reason: 'not written by the owner or someone with write access',
    author: 'someone',
    association,
    labels,
  });

  it('picks an OWNER issue without any permission lookup, ranked or not', () => {
    const permissionOf = () => {
      throw new Error('must not be called');
    };
    for (const labels of [[], ['high']]) {
      const { work } = triage([issue(1, labels, READY, 'someone', 'OWNER')], [], undefined, permissionOf);
      expect(work.map((w) => w.number)).toEqual([1]);
    }
  });

  it('picks a MEMBER or COLLABORATOR whose permission is admin, maintain or write', () => {
    for (const association of ['MEMBER', 'COLLABORATOR']) {
      for (const permission of ['admin', 'maintain', 'write']) {
        const asked: string[] = [];
        const permissionOf = (login: string) => (asked.push(login), permission);
        const { work } = triage([issue(1, [], READY, 'someone', association)], [], undefined, permissionOf);
        expect(work.map((w) => w.number)).toEqual([1]);
        expect(asked).toEqual(['someone']);
      }
    }
  });

  it('holds a MEMBER or COLLABORATOR whose permission is read, triage or none, even with a rank label', () => {
    for (const association of ['MEMBER', 'COLLABORATOR']) {
      for (const permission of ['read', 'triage', 'none']) {
        for (const labels of [[], ['critical']]) {
          const result = triage([issue(1, labels, '', 'someone', association)], [], undefined, () => permission);
          expect(result.work).toEqual([]);
          expect(result.skip[0]).toMatchObject({ reason: held(association).reason, author: 'someone', association });
        }
      }
    }
  });

  it('holds a MEMBER or COLLABORATOR when the lookup throws, and with no lookup at all', () => {
    const boom = () => {
      throw new Error('HTTP 404');
    };
    for (const association of ['MEMBER', 'COLLABORATOR']) {
      expect(triage([issue(1, [], READY, 'someone', association)], [], undefined, boom).work).toEqual([]);
      expect(triage([issue(1, [], READY, 'someone', association)], []).work).toEqual([]);
    }
  });

  it('holds a MEMBER with no login recorded', () => {
    const noLogin = { number: 1, title: 't', labels: [], authorAssociation: 'MEMBER' };
    expect(trusted(noLogin, () => 'admin')).toBe(false);
  });

  it('holds a CONTRIBUTOR or NONE issue even with a rank label and a permissive lookup', () => {
    for (const association of ['CONTRIBUTOR', 'NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR']) {
      for (const labels of [[], ['critical']]) {
        const result = triage([issue(1, labels, '', 'stranger', association), issue(2, [])], [], undefined, () => 'admin');
        expect(result.work.map((w) => w.number)).toEqual([2]);
        expect(result.skip).toEqual([
          { number: 1, reason: held(association).reason, author: 'stranger', association },
        ]);
      }
    }
  });

  it('renders the held issue with its author, association and the way to work it', () => {
    const text = render(triage([issue(1, ['high'], READY, 'stranger', 'NONE')], []));
    expect(text).toContain('#1 opened by stranger (NONE); copy it into an owner issue to work it\n');
    expect(text).not.toContain('issue 1');
    expect(JSON.stringify(triage([issue(1, ['high'], READY, 'stranger', 'NONE')], []))).not.toContain('issue 1');
  });

  const strangerLabelled = (label: string) => {
    const plan = triage([issue(1, [label], READY, 'stranger', 'NONE')], []);
    expect(render(plan)).toContain('#1 opened by stranger (NONE); copy it into an owner issue to work it\n');
    expect(render(plan)).not.toContain('issue 1');
    expect(JSON.stringify(plan)).not.toContain('issue 1');
    expect(plan.skip[0]).toMatchObject({ number: 1, author: 'stranger', association: 'NONE' });
  };

  it("lists a stranger's issue labelled human without its title", () => strangerLabelled('human'));

  it("lists a stranger's issue labelled template without its title", () => strangerLabelled('template'));

  it("still skips an owner's issue labelled human with its title and reason", () => {
    const plan = triage([issue(1, ['human'])], []);
    expect(plan.skip[0]).toMatchObject({ number: 1, title: 'issue 1', reason: 'needs a person (human)' });
    expect(render(plan)).toContain('issue 1');
  });

  it('holds an issue with no association recorded', () => {
    expect(trusted({ number: 1, title: 't', labels: ['high'], user: { login: OWNER } }, () => 'admin')).toBe(false);
    expect(triage([{ number: 1, title: 't', labels: [] }], []).skip[0]).toMatchObject({ author: 'unknown', association: 'unknown' });
  });
});

describe('permissionLookup', () => {
  it('reads the permission over REST and caches it per login', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ permission: 'write', user: { login: 'someone' } });
    };
    const permissionOf = permissionLookup(run);
    expect(permissionOf('someone')).toBe('write');
    expect(permissionOf('someone')).toBe('write');
    expect(calls).toEqual([['api', 'repos/{owner}/{repo}/collaborators/someone/permission']]);
  });

  it('lets a failed lookup throw, so trusted holds the issue', () => {
    const permissionOf = permissionLookup(() => {
      throw new Error('HTTP 404');
    });
    expect(() => permissionOf('stranger')).toThrow(/404/);
    expect(trusted({ number: 1, title: 't', labels: [], user: { login: 'stranger' }, authorAssociation: 'COLLABORATOR' }, permissionOf)).toBe(false);
  });
});

describe('fetchOpen carries the author association', () => {
  it("feeds triage: a stranger's ranked issue read from REST is held", () => {
    const run = () =>
      JSON.stringify([
        { number: 1, title: 'a', body: READY, labels: [{ name: 'high' }], user: { login: 'stranger' }, author_association: 'NONE' },
        { number: 2, title: 'b', body: READY, labels: [], user: { login: OWNER }, author_association: 'OWNER' },
      ]);
    const { issues, pullRequests } = fetchOpen(run);
    expect(issues.map((i) => i.authorAssociation)).toEqual(['NONE', 'OWNER']);
    const result = triage(issues, pullRequests);
    expect(result.work.map((w) => w.number)).toEqual([2]);
    expect(result.skip[0]).toMatchObject({ number: 1, author: 'stranger', association: 'NONE' });
  });
});

const body = (criteria: string, details: string) => `## Acceptance criteria\n${criteria}\n## Details to complete\n${details}\n## Tech notes\nx\n`;
const THEN = '\n**Scenario: a**\n- **Given** g\n- **When** w\n- **Then** t\n';

describe('readiness', () => {
  const ready = (b: string) => readiness({ number: 1, title: 't', labels: [], body: b });

  it('is null for criteria with a Then line and details with text', () => {
    expect(ready(body(THEN, '1. Use X.'))).toBeNull();
  });

  it('names missing acceptance criteria', () => {
    expect(ready(body('\n_placeholder_\n- **Given** only\n', 'text'))).toBe('no acceptance criteria');
    expect(ready('')).toBe('no acceptance criteria');
    expect(readiness({ number: 1, title: 't', labels: [] })).toBe('no acceptance criteria');
  });

  it('names missing details: absent, empty, only 1., only placeholders', () => {
    expect(ready(`## Acceptance criteria\n${THEN}`)).toBe('no details to complete');
    expect(ready(body(THEN, ''))).toBe('no details to complete');
    expect(ready(body(THEN, '1. '))).toBe('no details to complete');
    expect(ready(body(THEN, '_Everything the assignee needs._\n\n1.\n'))).toBe('no details to complete');
  });

  it('treats None as ready', () => {
    expect(ready(body(THEN, 'None'))).toBeNull();
  });

  it('reads CRLF bodies', () => {
    expect(ready(body(THEN, 'None').replace(/\n/g, '\r\n'))).toBeNull();
    expect(ready(body('\n', 'None').replace(/\n/g, '\r\n'))).toBe('no acceptance criteria');
  });

  it('does not count a Then inside a fenced code block', () => {
    expect(ready(body('\n```\n- **Then** t\n```\n', 'None'))).toBe('no acceptance criteria');
  });

  it('matches headings exactly', () => {
    expect(ready(`### Acceptance criteria\n${THEN}\n## Details to complete\nNone`)).toBe('no acceptance criteria');
  });
});

describe('readiness against the real template', () => {
  const template = readFileSync(new URL('../../.github/ISSUE_TEMPLATE/story.md', import.meta.url), 'utf8');
  const details = (text: string) => template.replace(/## Details to complete[\s\S]*?\n1\. \n/, `## Details to complete\n\n${text}\n`);

  it('judges the untouched acceptance block of the template not ready, even with real details', () => {
    const filled = details('Use X.');
    expect(filled).toContain('Use X.');
    expect(readiness({ number: 1, title: 't', labels: [], body: filled })).toBe('no acceptance criteria');
  });

  it('judges the template with real Then text ready', () => {
    const filled = details('None').replace('- **Then** [expected outcome]', '- **Then** the API answers 401');
    expect(readiness({ number: 1, title: 't', labels: [], body: filled })).toBeNull();
  });
});

describe('triage not ready', () => {
  it('lists a not-ready issue under notReady and keeps it out of work', () => {
    const plan = triage([issue(1, ['high'], 'no sections'), issue(2, ['medium'], body(THEN, '')), issue(3, ['medium'])], []);
    expect(plan.work.map((w) => w.number)).toEqual([3]);
    expect(plan.notReady).toEqual([
      { number: 1, title: 'issue 1', reason: 'no acceptance criteria' },
      { number: 2, title: 'issue 2', reason: 'no details to complete' },
    ]);
    const text = render(plan);
    expect(text).toContain('Not ready');
    expect(text).toContain('#1 no acceptance criteria: issue 1');
  });

  it('reports a skipped issue as skipped only, never also not ready', () => {
    const plan = triage(
      [issue(1, ['human'], ''), issue(2, ['template'], ''), issue(3, [], 'Depends on #4.'), issue(4, []), issue(5, [], '')],
      [{ number: 9, body: 'Closes #5' }],
    );
    expect(plan.skip.map((s) => s.number)).toEqual([1, 2, 3, 5]);
    expect(plan.notReady.map((n) => n.number)).toEqual([]);
  });

  it('does not count not-ready issues against the ceiling', () => {
    const issues = [1, 2, 3, 4, 5].map((n) => issue(n, ['medium'], ''));
    issues.push(issue(6, []), issue(7, []));
    const plan = triage(issues, [], 2);
    expect(plan.notReady).toHaveLength(5);
    expect(plan.work.map((w) => w.number)).toEqual([6, 7]);
    expect(plan.deferred).toEqual([]);
  });

  it('ranks an unranked ready issue last, as before', () => {
    const plan = triage([issue(1, []), issue(2, ['high'])], []);
    expect(plan.work.map((w) => w.number)).toEqual([2, 1]);
  });

  it('JSON output carries a notReady array', () => {
    const plan = JSON.parse(JSON.stringify(triage([issue(1, [], '')], [])));
    expect(plan.notReady).toEqual([{ number: 1, title: 'issue 1', reason: 'no acceptance criteria' }]);
  });
});
