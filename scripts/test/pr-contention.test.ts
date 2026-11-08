import { describe, expect, it } from 'vitest';
import {
  MARKER,
  MAX_PULL_REQUESTS,
  commentAction,
  contentionVerdict,
  mergeConflicts,
  parseMergeTree,
  partitionConflicts,
  refsToFetch,
  reportingTargets,
  selectPullRequests,
} from '../pr-contention.mjs';

// The shape `git merge-tree --write-tree --name-only` writes on a conflict:
// the merged tree's oid, the conflicted names, a blank line, then prose.
const conflicted = (...paths: string[]) =>
  `9d3d0d1f0a1b2c3d4e5f60718293a4b5c6d7e8f9\n${paths.join('\n')}\n\nAuto-merging ${paths[0]}\nCONFLICT (content): Merge conflict in ${paths[0]}\n`;

describe('parseMergeTree', () => {
  it('reads a clean merge as no conflicts', () => {
    expect(parseMergeTree(0, 'aaaabbbbccccdddd\n')).toEqual({ ok: true, conflicts: [] });
  });

  it('reads the conflicted file names out of a conflicted merge', () => {
    const result = parseMergeTree(1, conflicted('scripts/review-scope.mjs', 'a/b.test.ts'));
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(['scripts/review-scope.mjs', 'a/b.test.ts']);
  });

  it('stops at the blank line rather than swallowing the prose after it', () => {
    // The informational section names the conflicted file again, in a
    // sentence. Reading past the blank line would report
    // "CONFLICT (content): Merge conflict in ..." as a path.
    const { conflicts } = parseMergeTree(1, conflicted('one.mjs'));
    expect(conflicts).toEqual(['one.mjs']);
  });

  it('does not report a merge that could not run as a clean merge', () => {
    const result = parseMergeTree(128, 'fatal: not something we can merge\n');
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(true);
  });

  it('does not read an unfetched head as a conflict-free merge', () => {
    // The exit code cannot carry this. `git merge-tree` answers a head it does
    // not have with *exit 1 and nothing on stdout* — the same status as a real
    // conflict. Keying on the status alone produced "conflicts: none", which
    // this check would have printed as "merges cleanly" because git failed.
    // The unit tests passed while it did; a run against a real repository with
    // a missing head is what caught it.
    const result = parseMergeTree(1, '');
    expect(result.failed).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it('knows a merge ran because it wrote a tree, not because it exited 1', () => {
    expect(parseMergeTree(1, conflicted('a.mjs')).failed).toBeUndefined();
    expect(parseMergeTree(1, 'merge-tree: abc123 - not something we can merge\n').failed).toBe(
      true,
    );
  });
});

describe('mergeConflicts', () => {
  it('asks git for a write-tree merge and returns what it found', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { status: 1, stdout: conflicted('scripts/review-scope.mjs') };
    };
    const result = await mergeConflicts('base', 'head', run);
    expect(calls[0]).toEqual([
      'merge-tree',
      '--write-tree',
      '--name-only',
      'base',
      'head',
    ]);
    expect(result.conflicts).toEqual(['scripts/review-scope.mjs']);
  });

  it('reports a clean merge between two heads', async () => {
    const run = async () => ({ status: 0, stdout: 'aaaa\n' });
    expect(await mergeConflicts('a', 'b', run)).toEqual({ ok: true, conflicts: [] });
  });
});

describe('partitionConflicts', () => {
  it('separates the test files from the source files', () => {
    const { tests, sources } = partitionConflicts([
      'scripts/review-scope.mjs',
      'apps/web/src/review-scope.test.ts',
      'apps/api/tests/test_schema.py',
    ]);
    expect(tests).toEqual(['apps/web/src/review-scope.test.ts', 'apps/api/tests/test_schema.py']);
    expect(sources).toEqual(['scripts/review-scope.mjs']);
  });

  it('answers an empty conflict list with two empty lists', () => {
    expect(partitionConflicts([])).toEqual({ tests: [], sources: [] });
  });
});

describe('selectPullRequests', () => {
  it('compares oldest first, so the ceiling drops the newest', () => {
    const list = [{ number: 9 }, { number: 3 }, { number: 7 }];
    const { selected, truncated } = selectPullRequests(list, 2);
    expect(selected.map((pr) => pr.number)).toEqual([3, 7]);
    expect(truncated).toBe(1);
  });

  it('reports how many it left out rather than trimming quietly', () => {
    const list = Array.from({ length: MAX_PULL_REQUESTS + 4 }, (_, i) => ({ number: i + 1 }));
    expect(selectPullRequests(list).truncated).toBe(4);
  });

  it('ignores entries that carry no pull request number', () => {
    expect(selectPullRequests([{ number: 1 }, {} as { number: number }]).selected).toHaveLength(1);
  });
});

describe('refsToFetch', () => {
  const many = Array.from({ length: MAX_PULL_REQUESTS + 3 }, (_, i) => ({ number: i + 1 }));

  it('fetches the heads it is going to compare', () => {
    expect(refsToFetch([{ number: 3 }, { number: 7 }])).toEqual([
      'refs/pull/3/head',
      'refs/pull/7/head',
    ]);
  });

  it('fetches the triggering pull request even when the ceiling drops it', () => {
    // The ceiling bounds the rivals, where the quadratic cost is. The subject
    // is reported on regardless, so deriving the fetch list from the ceiling
    // alone left its head unfetched — every comparison against it then failed,
    // on exactly the pull request that must never go unreported.
    const refs = refsToFetch(many, [MAX_PULL_REQUESTS + 3]);
    expect(refs).toContain(`refs/pull/${MAX_PULL_REQUESTS + 3}/head`);
    expect(refs).toHaveLength(MAX_PULL_REQUESTS + 1);
  });

  it('does not fetch a head for a pull request that is not open', () => {
    expect(refsToFetch([{ number: 3 }], [999])).toEqual(['refs/pull/3/head']);
  });
});

describe('reportingTargets', () => {
  it('reports on every open pull request, not only the one that triggered the run', () => {
    // The defect this fixes: reporting only the trigger left the pull request
    // that was already open with no warning at all, because a rival opening
    // gives it no event of its own. #132 is told about #131; #131 would be
    // told nothing, and then lose the race it was never warned about.
    const open = [{ number: 131 }, { number: 132 }];
    expect(reportingTargets(open, [132]).map((pr) => pr.number)).toEqual([131, 132]);
  });

  it('includes a named pull request the ceiling would have dropped', () => {
    const many = Array.from({ length: MAX_PULL_REQUESTS + 3 }, (_, i) => ({ number: i + 1 }));
    const numbers = reportingTargets(many, [MAX_PULL_REQUESTS + 3]).map((pr) => pr.number);
    expect(numbers).toContain(MAX_PULL_REQUESTS + 3);
    expect(numbers).toHaveLength(MAX_PULL_REQUESTS + 1);
  });

  it('fetches a head for every pull request it will report on', () => {
    // These two disagreed once, and the pull request being reported on was
    // compared against a head that had never been fetched. Derived from one
    // list now, and asserted to stay that way.
    const many = Array.from({ length: MAX_PULL_REQUESTS + 3 }, (_, i) => ({ number: i + 1 }));
    const only = [MAX_PULL_REQUESTS + 2];
    expect(refsToFetch(many, only)).toEqual(
      reportingTargets(many, only).map((pr) => `refs/pull/${pr.number}/head`),
    );
  });
});

describe('contentionVerdict', () => {
  const subject = { number: 107, title: 'Fold case before testing the prefix' };

  it('is clear when nothing conflicts', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      rivals: [{ number: 108, conflicts: [] }],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe('clear');
    expect(verdict.headline).toContain('1 other open pull request');
  });

  it('names the sibling that cannot land alongside it', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      rivals: [
        { number: 108, title: 'Extract canonical()', conflicts: ['scripts/review-scope.mjs'] },
        { number: 110, conflicts: [] },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.state).toBe('rivals');
    expect(verdict.detail).toContain('#108');
    expect(verdict.detail).not.toContain('#110');
  });

  it('says a clean base merge does not make two changes compatible', () => {
    // Two branches can share a contract and not a line. A verdict that read
    // "no contention" without that caveat would be making a claim it cannot
    // support, which is the shape SOP 3 exists for.
    const verdict = contentionVerdict({ subject, base: { ref: 'develop', conflicts: [] } });
    expect(verdict.detail).toContain('share a contract without sharing a line');
  });

  it('puts the base conflict first when the branch has already gone stale', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: ['scripts/review-scope.mjs'] },
      rivals: [{ number: 110, conflicts: ['scripts/review-scope.mjs'] }],
    });
    expect(verdict.state).toBe('base');
    expect(verdict.headline).toContain('no longer merges');
    // The sibling still matters, but the stale base is the thing to do first.
    expect(verdict.detail).toContain('#110');
  });

  it('warns that a conflicting test file is a union and not a choice', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      rivals: [{ number: 108, conflicts: ['apps/web/src/review-scope.test.ts'] }],
    });
    expect(verdict.detail).toContain('union, not a choice');
    expect(verdict.detail).toContain('test census');
  });

  it('does not warn about test resolution when no test file conflicts', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      rivals: [{ number: 108, conflicts: ['scripts/review-scope.mjs'] }],
    });
    expect(verdict.detail).not.toContain('union, not a choice');
  });

  it('does not report a merge that could not run as a clean one', () => {
    // The whole check descends from a signal that was reassuring and wrong.
    // `failed` carries no conflicts, which is the same shape as a clean merge,
    // so a verdict that read the two alike would print "merges cleanly"
    // because git fell over. That is the defect, not a report of it.
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [], failed: true },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.state).toBe('unknown');
    expect(verdict.headline).toContain('could not be established');
  });

  it('names a rival whose comparison did not run', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      rivals: [{ number: 108, conflicts: [], failed: true }],
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.detail).toContain('#108');
  });

  it('still reports real contention when another comparison did not run', () => {
    // A conflict found elsewhere does not excuse the comparison that failed.
    // Both belong in the comment, with the conflict leading.
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      rivals: [
        { number: 108, conflicts: ['scripts/review-scope.mjs'] },
        { number: 110, conflicts: [], failed: true },
      ],
    });
    expect(verdict.state).toBe('rivals');
    expect(verdict.detail).toContain('unknown rather than clean');
    expect(verdict.detail).toContain('#110');
  });

  it('reports the ceiling in the output when it bites', () => {
    const verdict = contentionVerdict({
      subject,
      base: { ref: 'develop', conflicts: [] },
      truncated: 3,
    });
    expect(verdict.detail).toContain('3 further open pull requests were not compared');
  });
});

describe('commentAction', () => {
  const warning = contentionVerdict({
    subject: { number: 107 },
    base: { ref: 'develop', conflicts: [] },
    rivals: [{ number: 108, conflicts: ['scripts/review-scope.mjs'] }],
  });
  const clear = contentionVerdict({ subject: { number: 107 }, base: { ref: 'develop' } });

  it('posts a new comment when contention is found and none was reported', () => {
    const action = commentAction({ existing: null, verdict: warning });
    expect(action?.method).toBe('POST');
    expect(action?.body).toContain(MARKER);
  });

  it('edits its own comment instead of posting a second one', () => {
    const action = commentAction({ existing: { id: 42, body: 'stale' }, verdict: warning });
    expect(action).toMatchObject({ method: 'PATCH', id: 42 });
  });

  it('writes nothing when the verdict has not changed', () => {
    const body = commentAction({ existing: null, verdict: warning })!.body;
    expect(commentAction({ existing: { id: 42, body }, verdict: warning })).toBeNull();
  });

  it('says nothing at all on a clean pull request it has never warned about', () => {
    expect(commentAction({ existing: null, verdict: clear })).toBeNull();
  });

  it('replaces its own warning once the contention clears', () => {
    // A stale conflict warning is worse than no warning: the next reader goes
    // and resolves a conflict that is not there.
    const action = commentAction({ existing: { id: 42, body: 'old warning' }, verdict: clear });
    expect(action?.method).toBe('PATCH');
    expect(action?.body).toContain('It has cleared.');
  });
});
