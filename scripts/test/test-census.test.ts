import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreeFiles } from '../git-files.mjs';
import { canonical } from '../paths.mjs';
import { apps, loadProject } from '../project.mjs';
import {
  ACKNOWLEDGEMENT,
  census,
  censusVerdict,
  countTests,
  isTestFile,
} from '../test-census.mjs';

const ts = (...tests: string[]) =>
  `import { describe, expect, it } from 'vitest';\n\ndescribe('a thing', () => {\n${tests
    .map((name) => `  it('${name}', () => { expect(1).toBe(1); });\n`)
    .join('')}});\n`;

const py = (...tests: string[]) =>
  tests.map((name) => `def test_${name}(client):\n    assert client\n\n`).join('');

describe('countTests', () => {
  it('counts the tests in a vitest file', () => {
    expect(countTests('a.test.ts', ts('one', 'two', 'three'))).toMatchObject({ count: 3 });
  });

  it('counts the tests in a pytest file', () => {
    expect(countTests('tests/test_a.py', py('one', 'two'))).toMatchObject({ count: 2 });
  });

  it('counts a skipped or todo test, because it is still present', () => {
    // Turning a test off is a different act from deleting it, visible in the
    // diff and in the runner's own output. This check is about disappearance.
    const source = `it.skip('off', () => {});\ntest.todo('later');\nit('on', () => {});\n`;
    expect(countTests('a.test.ts', source)).toMatchObject({ count: 3 });
  });

  it('does not count a word that merely ends in test', () => {
    // `submit(`, `latest(`, `request(` and a property access like
    // `runner.test(` are not test declarations, and counting them would make
    // the total drift with ordinary refactoring.
    const source = `submit(form);\nconst x = latest();\nrunner.test(thing);\nit('real', () => {});\n`;
    expect(countTests('a.test.ts', source)).toMatchObject({ count: 1 });
  });

  it('does not count describe blocks', () => {
    expect(countTests('a.test.ts', `describe('group', () => {});\n`)).toMatchObject({ count: 0 });
  });

  it('counts a table-driven test once, and says that it did', () => {
    // One declaration, many results. Counting it once is what keeps the file
    // in the comparison at all, so a whole function deleted from a
    // parametrised suite is still caught; the cost is that a row deleted from
    // inside the table is not, which is why the file gets flagged.
    //
    // Spelled in two pieces here and below so this file does not trip its own
    // detector. The detector is textual, which is the price of not installing
    // both toolchains twice to count.
    const each = `it${'.each'}([1, 2, 3])('case %i', (n) => { expect(n).toBeTruthy(); });\n`;
    const counted = countTests('a.test.ts', each);
    expect(counted.count).toBe(1);
    expect(counted.tabular[0]).toContain('.each');

    const parametrized = `import pytest\n\n@pytest.mark${'.parametrize'}("n", [1, 2])\ndef test_n(n):\n    assert n\n`;
    const python = countTests('tests/test_a.py', parametrized);
    expect(python.count).toBe(1);
    expect(python.tabular[0]).toContain('parametrize');
  });

  it('counts the tagged-template table too, not only the array one', () => {
    // Found in review. `it.each` with a template literal is ordinary vitest
    // syntax, and the first draft's regex wanted a `(` where the backtick is.
    // It counted zero while still flagging the file as table-driven, so
    // deleting the whole block would have moved the total by nothing — a
    // missing declaration rather than the missing rows the header discloses.
    const tagged = `it${'.each'}\`\n  a | b\n  1 | 2\n\`('adds %i', () => {});\n`;
    expect(countTests('a.test.ts', tagged)).toMatchObject({ count: 1 });

    const both = `${tagged}it('a literal one', () => {});\n`;
    expect(countTests('a.test.ts', both).count).toBe(2);
  });

  it('flags nothing when nothing is table-driven', () => {
    expect(countTests('a.test.ts', ts('one'))).toMatchObject({ count: 1, tabular: [] });
    expect(countTests('tests/test_a.py', py('one'))).toMatchObject({ count: 1, tabular: [] });
  });
});

describe('isTestFile', () => {
  it('recognises the three kinds this repository has', () => {
    expect(isTestFile('apps/web/src/api.test.ts')).toBe(true);
    expect(isTestFile('apps/web/src/App.test.tsx')).toBe(true);
    expect(isTestFile('apps/web/e2e/docs.spec.ts')).toBe(true);
    expect(isTestFile('apps/api/tests/test_tree.py')).toBe(true);
  });

  it('recognises a test file however deep it sits', () => {
    // Found in review. Requiring a Python test to be a direct child of
    // `tests/` meant that reorganising a suite into `tests/unit/` dropped
    // every file in it out of *both* trees — so no delta is ever computed and
    // nothing reports a thing. Not a removal this check misses: a file it
    // silently stops covering, permanently. Matching pytest's own discovery
    // rule — the basename, at any depth — is what closes it.
    expect(isTestFile('apps/api/tests/unit/test_tree.py')).toBe(true);
    expect(isTestFile('apps/api/tests/unit/deep/test_tree.py')).toBe(true);
    expect(isTestFile('apps/api/src/api/tree_test.py')).toBe(true);
    expect(isTestFile('apps/web/src/components/cards/PersonCard.test.tsx')).toBe(true);
  });

  it('compares paths the one way this repository compares paths', () => {
    // Path comparisons here get a single shared normalisation, because a
    // comparison that folds case in one place and not the next is exactly
    // how a path silently stops matching. A weaker, re-derived copy — trim
    // and strip `./`, no case fold — would be the first step back towards
    // that, so this imports `canonical` from the same place review-scope.mjs
    // does. The stake is the same as everywhere else here: a
    // file that stops matching leaves both trees at once and reports nothing.
    expect(isTestFile('./Apps/Api/Tests/Test_Tree.PY')).toBe(true);
    expect(isTestFile('  apps/web/src/API.Test.TS  ')).toBe(true);
    expect(canonical('  ./Apps/Api/Tests/Test_Tree.PY  ')).toBe('apps/api/tests/test_tree.py');
  });

  it('ignores source files, fixtures and anything vendored', () => {
    for (const path of [
      'apps/web/src/api.ts',
      'apps/api/src/api/tree.py',
      'apps/web/e2e/api-servers.ts',
      'node_modules/x/index.test.js',
      'apps/web/node_modules/x/a.test.ts',
      'apps/api/.venv/Lib/site-packages/pytest/test_thing.py',
      'docs/adoption.md',
    ]) {
      expect(isTestFile(path)).toBe(false);
    }
  });
});

describe('censusVerdict', () => {
  const tree = (counts: Record<string, number>) =>
    census(
      Object.fromEntries(
        Object.entries(counts).map(([path, n]) => [
          path,
          ts(...Array.from({ length: n }, (_, i) => `case ${i}`)),
        ]),
      ),
    );

  it('passes a change that adds tests', () => {
    const verdict = censusVerdict({ base: tree({ 'a.test.ts': 3 }), head: tree({ 'a.test.ts': 5 }) });
    expect(verdict.ok).toBe(true);
    expect(verdict.headline).toContain('rises from 3 to 5');
  });

  it('passes a change that touches no test', () => {
    const same = tree({ 'a.test.ts': 4 });
    expect(censusVerdict({ base: same, head: same })).toMatchObject({ ok: true, removed: 0 });
  });

  it('fails a change that quietly drops one, and names the file', () => {
    // This is the shape that gets through unnoticed — review-scope.test.ts
    // dropping from 14 tests to 13 during a conflict resolution while every
    // check stays green.
    const verdict = censusVerdict({
      base: tree({ 'review-scope.test.ts': 14, 'other.test.ts': 9 }),
      head: tree({ 'review-scope.test.ts': 13, 'other.test.ts': 9 }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.removed).toBe(1);
    expect(verdict.detail).toContain('review-scope.test.ts');
    expect(verdict.detail).not.toContain('other.test.ts');
  });

  it('counts a whole deleted test file as the tests it held', () => {
    const verdict = censusVerdict({ base: tree({ 'a.test.ts': 6 }), head: tree({}) });
    expect(verdict).toMatchObject({ ok: false, removed: 6 });
  });

  it('lets the removal through when the pull request says so', () => {
    const verdict = censusVerdict({
      base: tree({ 'a.test.ts': 6 }),
      head: tree({ 'a.test.ts': 4 }),
      body: 'Drops the export.\n\nRemoves tests: the two covering the CSV export, which this deletes.\n',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.removed).toBe(2);
  });

  it('wants a reason, not just the words', () => {
    // A bare `Removes tests:` with nothing after it is not an acknowledgement.
    expect(ACKNOWLEDGEMENT.test('Removes tests:')).toBe(false);
    expect(ACKNOWLEDGEMENT.test('Removes tests:\n\nSomething else entirely.')).toBe(false);
    expect(ACKNOWLEDGEMENT.test('Removes tests: the CSV ones.')).toBe(true);
    expect(ACKNOWLEDGEMENT.test('- Removes tests: the CSV ones.')).toBe(true);
    expect(ACKNOWLEDGEMENT.test('this removes tests: sometimes')).toBe(false);
  });

  it('takes the reason on the line below, because that is how people write it', () => {
    // A colon and a bullet list underneath is the natural spelling, and a
    // check that rejected it would go red while the author had explained
    // themselves one line down. A check that rejects the natural spelling
    // of compliance gets ignored.
    const body = 'Drops the CSV export.\n\nRemoves tests:\n- the two covering it, which this deletes\n';
    expect(ACKNOWLEDGEMENT.test(body)).toBe(true);
    expect(
      censusVerdict({
        base: census({ 'a.test.ts': ts('one', 'two', 'three') }),
        head: census({ 'a.test.ts': ts('one') }),
        body,
      }),
    ).toMatchObject({ ok: true, removed: 2 });
  });

  it('reads a rename as a rename, not a removal', () => {
    // The requirement above states outright. Names change constantly — a check
    // that went red for a rename would be trained out of people in a week, and
    // the one time it was right nobody would look.
    const base = census({ 'a.test.ts': ts('renders a card', 'derives siblings') });
    const head = census({ 'renamed.test.ts': ts('renders a person card', 'derives siblings') });
    expect(censusVerdict({ base, head })).toMatchObject({ ok: true, removed: 0 });
  });

  it('reads a refactor into a table as a refactor, not three removals', () => {
    // Three literal tests folded into one `it.each` of three rows is the one
    // case where counting declarations misleads, so the file that just became
    // table-driven leaves the comparison and the summary says which and why.
    const base = census({ 'a.test.ts': ts('one', 'two', 'three'), 'b.test.ts': ts('keep') });
    const head = census({
      'a.test.ts': `it${'.each'}([1, 2, 3])('case %i', () => {});\n`,
      'b.test.ts': ts('keep'),
    });
    const verdict = censusVerdict({ base, head });
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain('a.test.ts');
    expect(verdict.detail).toContain('refactor');
  });

  it('counts a brand-new table-driven file rather than calling it a refactor', () => {
    // Found in review, on this pull request itself: a file absent from the
    // base is also absent from its tabular list, so a new table-driven file
    // took the refactor exclusion and vanished from the total, with the
    // summary explaining the disappearance as a refactor of something that
    // had never existed. The check reported "holds at 368" on the pull
    // request adding twenty-five tests.
    const verdict = censusVerdict({
      base: census({}),
      head: census({ 'new.test.ts': `it${'.each'}([1, 2, 3])('case %i', () => {});\n` }),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.headline).toContain('rises from 0 to 1');
    expect(verdict.detail).not.toContain('refactor');
  });

  it('keeps a file that was already table-driven inside the comparison', () => {
    // The whole reason declarations are counted rather than results: deleting
    // a parametrised function from a suite that has always been parametrised
    // is a removal, and excluding the file for being table-driven would have
    // let it through.
    const table = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `@pytest.mark${'.parametrize'}("n", [1, 2])\ndef test_case_${i}(n):\n    assert n\n\n`,
      ).join('');
    const verdict = censusVerdict({
      base: census({ 'tests/test_a.py': table(4) }),
      head: census({ 'tests/test_a.py': table(3) }),
    });
    expect(verdict).toMatchObject({ ok: false, removed: 1 });
    expect(verdict.detail).toContain('does not show up here');
  });

  it('defaults to passing on nothing at all', () => {
    // Unlike assert-review-ran.mjs, whose default has to be failure. Here an
    // empty base and an empty head is a repository with no tests either side,
    // and there is no removal to report.
    expect(censusVerdict()).toMatchObject({ ok: true, removed: 0 });
  });
});

describe('the premise: this repository can actually be counted', () => {
  // The static count is only right while every test here is a literal call.
  // This walks the real suites, so the first `.each` or `parametrize` anyone
  // adds turns up as a failure pointing at test-census.mjs, rather than as a
  // count that quietly stops matching the runner.
  const root = resolve(__dirname, '../..');

  // Every suite, not only the ones anyone thinks of first: every app can
  // have its own, and the AI layer's own live in scripts/test. A census
  // that walked a hand-written list of directories would stop seeing a
  // suite the day a new one is added, which is this repository's signature
  // failure wearing a different hat. So this asks git for every tracked file,
  // and every new one not yet added: verify runs before the first commit, and
  // a test file nobody has added must fail here as it will in CI (#257).
  const everything = worktreeFiles(root);
  const testFiles = everything.filter(isTestFile);

  it("finds every suite: the AI layer's own, and one in every declared app", () => {
    expect(testFiles.length).toBeGreaterThan(10);
    expect(testFiles).toContain('scripts/test/test-census.test.ts');
    // Every app project.json declares, not a hand-written list of the ones
    // anyone thinks of first.
    for (const [name, app] of apps(loadProject())) {
      expect(testFiles.some((path) => path.startsWith(`${app.path}/`)), name).toBe(true);
    }
  });

  it('leaves behind no file that looks like a test', () => {
    // The check above would still pass if one file quietly stopped matching,
    // which is how the nested-directory gap got in. This one asks the
    // question the other way round: of everything on disk that a person would
    // call a test, is there anything the census does not see?
    const looksLikeATest = everything.filter((path) =>
      /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*\.(test|spec)\.[jt]sx?)$/.test(path),
    );
    expect(looksLikeATest.length).toBeGreaterThan(10);
    expect(looksLikeATest.filter((path) => !isTestFile(path))).toEqual([]);
  });

  it('finds tests in every one of them', () => {
    // A parser that silently matched nothing in a file would read as "no
    // tests removed" there forever.
    const empty = testFiles.filter(
      (path) => countTests(path, readFileSync(join(root, path), 'utf8')).count === 0,
    );
    expect(empty).toEqual([]);
  });

  it('names the files whose rows it cannot see', () => {
    const tables = testFiles.filter(
      (path) => countTests(path, readFileSync(join(root, path), 'utf8')).tabular.length > 0,
    );

    // A row deleted from inside a table-driven file is the blind spot this
    // check has. Listing such files rather than asserting a count keeps that
    // visible: a new one is fine, and has to be a decision somebody made
    // rather than something that drifted in.
    //
    // The one AI-layer entry is this file, which contains no table at all — it
    // *discusses* `it.each` in a comment, and the detector reads comments
    // because it reads text. Being flagged costs it nothing (its declarations
    // are still counted, and a file flagged on both sides stays in the
    // comparison), and the alternative — a detector that parses instead of
    // matching — is not worth what it would cost here.
    // Outside the application, the list is exact. Inside it, which files are
    // table-driven is the application's business (the AI layer's tests
    // name no app), so each has only to sit inside a declared app, and an app
    // with none is equally fine; the census names every one of them in its
    // summary on the pull request, which is where a new one is seen. That the
    // detector sees tables at all is proven by the unit tests above.
    const appPaths = apps(loadProject()).map(([, app]) => `${app.path}/`);
    const inApps = tables.filter((path) => appPaths.some((prefix) => path.startsWith(prefix)));
    // assemble.test.ts is table-driven over the combinations of starters, a
    // fixed product of the catalogue's starters: a dropped row means a dropped
    // starter, which catalogue.test.ts catches. It tests how a product is
    // built, so it is listed in catalogue.json's `base` and a product does not
    // have it; where it exists the list stays exact, and where it does not
    // there is nothing for the list to name.
    //
    // spawn-timeout.test.ts has no table either: its comments and fixtures
    // name `it.each` because it refuses a table-driven spawner it cannot read.
    const buildsProducts = existsSync(join(root, 'scripts/test/assemble.test.ts'));
    expect(tables.filter((path) => !inApps.includes(path))).toEqual([
      ...(buildsProducts ? ['scripts/test/assemble.test.ts'] : []),
      'scripts/test/spawn-timeout.test.ts',
      'scripts/test/test-census.test.ts',
    ]);
  });
});

describe('worktreeFiles sees an untracked file (#257)', () => {
  // Timeout: real git init and add in a temporary repository (<=100 ms quiet); 15 s.
  it('lists tracked and new files, not ignored ones, so an unlisted test is caught', { timeout: 15_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-test-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(dir, 'a.test.ts'), ts('one'));
      git('add', 'a.test.ts');
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts', 'new.test.ts'), ts('two'));
      writeFileSync(join(dir, '.gitignore'), 'ignored.test.ts\n');
      writeFileSync(join(dir, 'ignored.test.ts'), ts('three'));
      const files = worktreeFiles(dir);
      expect(files).toContain('scripts/new.test.ts');
      expect(files).toContain('a.test.ts');
      expect(files).not.toContain('ignored.test.ts');
      expect(files.filter(isTestFile)).toContain('scripts/new.test.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the census counts against the merge-base (#372)', () => {
  const script = resolve(__dirname, '..', 'test-census.mjs');

  // Real git in a temp repo: `main` and a branch, each commit adding or
  // dropping test files. Returns helpers bound to that repo.
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-mb-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
    const commit = (message: string) => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const run = (base: string, head: string) => {
      try {
        const stdout = execFileSync('node', [script, base, head], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PR_BODY: '', GITHUB_STEP_SUMMARY: '' },
        });
        return { status: 0, out: stdout };
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        return { status: e.status, out: `${e.stdout}${e.stderr}` };
      }
    };
    return { dir, git, write, commit, run };
  };

  // Timeout: two to four real git commands and one node spawn (<=1 s quiet); 30 s.
  it('passes a branch cut before develop gained 14 tests', { timeout: 30_000 }, () => {
    const f = fixture();
    try {
      f.git('init', '-q', '-b', 'main');
      f.write('a.test.ts', ts('one', 'two'));
      f.commit('start');
      f.git('checkout', '-q', '-b', 'feature');
      f.write('b.test.ts', ts('feature'));
      const head = f.commit('feature adds a test');
      f.git('checkout', '-q', 'main');
      f.write('c.test.ts', ts(...Array.from({ length: 14 }, (_, i) => `later${i}`)));
      const base = f.commit('develop gains 14 tests');
      const result = f.run(base, head);
      expect(result.out).toContain('The test count rises from 2 to 3');
      expect(result.status).toBe(0);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  // Timeout: as above; 30 s.
  it('fails a branch that really deletes 3 tests, naming the file', { timeout: 30_000 }, () => {
    const f = fixture();
    try {
      f.git('init', '-q', '-b', 'main');
      f.write('a.test.ts', ts('one', 'two', 'three', 'four'));
      f.commit('start');
      f.git('checkout', '-q', '-b', 'feature');
      f.write('a.test.ts', ts('one'));
      const head = f.commit('delete three');
      f.git('checkout', '-q', 'main');
      f.write('c.test.ts', ts('later'));
      const base = f.commit('develop moves on');
      const result = f.run(base, head);
      expect(result.out).toContain('3 tests disappear');
      expect(result.out).toContain('`a.test.ts`: 3 fewer');
      expect(result.status).toBe(1);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  // Timeout: as above; 30 s.
  it('fails with a message naming the missing merge-base for unrelated histories', { timeout: 30_000 }, () => {
    const f = fixture();
    try {
      f.git('init', '-q', '-b', 'main');
      f.write('a.test.ts', ts('one', 'two'));
      const base = f.commit('base');
      f.git('checkout', '-q', '--orphan', 'other');
      f.git('rm', '-rq', '--cached', '.');
      f.write('b.test.ts', ts('one', 'two', 'three'));
      const head = f.commit('unrelated');
      const result = f.run(base, head);
      expect(result.out).toContain('No merge-base');
      expect(result.status).toBe(1);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('a git failure that is not a missing merge-base says what git said (#372)', () => {
  // Timeout: one real git init and one node spawn (<=1 s quiet); 30 s.
  it('reports git\'s own error for an unknown ref, not a missing merge-base', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-bad-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'a.test.ts'), ts('one'));
      git('add', '-A');
      git('commit', '-q', '-m', 'start');
      const head = git('rev-parse', 'HEAD');
      let out = '';
      let status = 0;
      try {
        execFileSync('node', [resolve(__dirname, '..', 'test-census.mjs'), 'deadbeef', head], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PR_BODY: '', GITHUB_STEP_SUMMARY: '' },
        });
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        status = e.status;
        out = `${e.stdout}${e.stderr}`;
      }
      expect(status).toBe(1);
      expect(out).toContain('git merge-base deadbeef');
      expect(out).toMatch(/deadbeef|Not a valid/i);
      expect(out).not.toContain('No merge-base between');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
