// Count the tests a pull request removes, and make it say so.
//
// `verify` observes whether the tests that are present pass. Nothing observed
// which tests were present, so a pull request could delete one and stay
// green. Resolving a conflict between two branches that both added a test at
// the same anchor can drop assertions silently — the code stays correct, the
// proof does not, and every check goes green.
//
// This is not a coverage gate. No percentage, no threshold, no ratchet on
// lines. The claim is narrower and checkable: a pull request that ends up with
// fewer tests than its base should have to say so in the pull request body. A
// deliberate removal is fine — a test for a feature being deleted has to go —
// but it is a decision, and a decision belongs where someone reads it rather
// than inside a diff nobody counted.
//
// WHAT IT COUNTS. Test *declarations*, statically, from the source of the test
// files at two commits: every `it(`, `test(` and `def test_`. Not a run — a
// count that needed both toolchains installed twice would cost more than the
// defect does — and not the number the runner reports either, which is the
// honest limit of it. A table-driven test (`it.each`, `@pytest.mark.parametrize`)
// is one declaration and many results, so **a row deleted from a table is
// invisible to this check**. Four files here are table-driven and the summary
// names them, so what is not covered is on the page rather than implied.
//
// Declarations rather than results is the trade that keeps every file in the
// comparison. Counting results would mean parsing table literals, and giving
// up on files whose tables it could not parse — which is worse, because a
// whole deleted function in one of those files would then go unseen. The one
// case where declarations mislead is a refactor from N literal `it(`s into one
// `it.each` of N rows, which reads as N-1 removals; a file that is table-driven
// on this side and was not on the base drops out of the comparison for exactly
// that reason.
import { pathToFileURL } from 'node:url';
import { canonical } from './paths.mjs';

/**
 * Test files, by name rather than by where they sit.
 *
 * The first draft required a Python test to be a direct child of `tests/`, so
 * `apps/api/tests/unit/test_foo.py` would have matched nothing — and a file
 * that matches nothing vanishes from *both* trees, which is not a removal this
 * check reports but a file it silently stops covering, permanently. That is
 * the shape SOP 3 is about, so the rule is the basename: pytest's own default
 * discovery is `test_*.py` and `*_test.py` at any depth, and this follows it.
 *
 * `canonical` rather than a trim-and-strip of its own: one comparison folding
 * case and the next one not is exactly the kind of drift a single shared
 * normalisation prevents, and a second weaker copy in this file would be the
 * first step back towards it. A file that stopped matching would leave both trees at once and
 * report nothing, which is the failure this whole script exists to catch.
 */
export function isTestFile(path) {
  const clean = canonical(path);
  if (/(^|\/)(node_modules|\.venv|site-packages|__pycache__)\//.test(clean)) return false;
  if (/\.(test|spec)\.(ts|tsx|mts|js|mjs)$/.test(clean)) return true;
  if (/(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(clean)) return true;
  return false;
}

/**
 * Constructs where one declaration produces many results. They still count as
 * one declaration; what they cost is visibility into the rows inside them,
 * which is why a file carrying one is named in the summary.
 */
const TABULAR = [
  { pattern: /\b(it|test|describe|bench)\.(each|for)\b/, why: '`.each` — one line, many tests' },
  {
    pattern: /\bpytest\.mark\.parametrize\b/,
    why: '`@pytest.mark.parametrize` — one function, many tests',
  },
];

/**
 * How many tests a file declares, and whether any of them are table-driven.
 *
 * Counts `it(` and `test(` for the JavaScript suites and `def test_` for the
 * Python one. `it.skip` and `test.todo` count: a skipped test is still a test
 * that is present, and turning one into the other is not what this looks for.
 * `it.each(` counts once, for the reason in this file's header.
 */
export function countTests(path, source) {
  const text = String(source ?? '');
  const tabular = TABULAR.filter(({ pattern }) => pattern.test(text)).map(({ why }) => why);

  if (String(path).endsWith('.py')) {
    const defs = text.match(/^[ \t]*(async[ \t]+)?def[ \t]+test_\w*[ \t]*\(/gm) ?? [];
    return { count: defs.length, tabular };
  }

  // The trailing `[(\`]` admits vitest's tagged-template table,
  // ``it.each`a | b` ``, and not only ``it.each([…])``. Without the backtick
  // that declaration counted zero while the file was still flagged tabular —
  // so deleting the whole block would have moved the total by nothing at all,
  // which is worse than the row-level blind spot this check discloses.
  const calls =
    text.match(
      /(^|[^.\w$])(it|test)(\.(skip|only|todo|fails|concurrent|sequential|runIf|skipIf|each|for))*[ \t]*[(`]/g,
    ) ?? [];
  return { count: calls.length, tabular };
}

/**
 * The census of a whole tree: the declarations in each test file, which of
 * those files are table-driven, and the total.
 */
export function census(files) {
  const counts = {};
  const tabular = {};
  for (const [path, source] of Object.entries(files ?? {})) {
    if (!isTestFile(path)) continue;
    const counted = countTests(path, source);
    counts[path] = counted.count;
    if (counted.tabular.length > 0) tabular[path] = counted.tabular;
  }
  return {
    counts,
    tabular,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}

/**
 * The line a pull request body has to carry to remove a test deliberately.
 *
 * The reason may follow on the same line or on the next one, because a colon
 * and a bullet list underneath is how people actually write this:
 *
 *     Removes tests:
 *     - the two covering the CSV export, because that feature is gone
 *
 * Requiring the reason on the same line would go red on that body while the
 * author had explained themselves one line down. A check that rejects the
 * natural spelling of compliance teaches people to ignore it.
 * What it still refuses is a bare `Removes tests:` with nothing after it.
 */
export const ACKNOWLEDGEMENT = /^[ \t>*-]*removes tests:[ \t]*(\S|\r?\n[ \t>*-]*\S)/im;

/**
 * Did this change lose tests, and did it say so?
 *
 * Compares totals rather than names, deliberately: a renamed test is the same
 * test, and a check that read a rename as a removal would be clicked past
 * within a week. A file that has *become* table-driven leaves the comparison,
 * because N literal tests folded into one `it.each` of N rows is a refactor
 * and not a removal — the only case where counting declarations misleads.
 */
export function censusVerdict({ base, head, body = '' } = {}) {
  const left = { counts: {}, tabular: {}, ...(base ?? {}) };
  const right = { counts: {}, tabular: {}, ...(head ?? {}) };

  // `path in left.counts`, not `!(path in left.tabular)`. A file absent from
  // the base is also absent from its tabular list, so the first spelling
  // dropped every *new* table-driven file out of the count and told the reader
  // it was "a refactor" — which it is not, and this pull request was the
  // example: the file adding this check reported "holds at 368" while adding
  // twenty-five tests. Only a file that was there, countable, and has become
  // table-driven can read as a removal, and only that one needs excluding.
  const converted = Object.keys(right.tabular).filter(
    (path) => path in left.counts && !(path in left.tabular),
  );
  const excluded = new Set(converted);
  const sum = (side) =>
    Object.entries(side.counts)
      .filter(([path]) => !excluded.has(path))
      .reduce((total, [, n]) => total + n, 0);

  const before = sum(left);
  const after = sum(right);
  const tables = Object.keys(right.tabular).sort();
  const aside = [
    converted.length
      ? `\n\nLeft out of the comparison because ${converted.length === 1 ? 'it is' : 'they are'} table-driven here and ${converted.length === 1 ? 'was' : 'were'} not on the base, which reads as a removal but is a refactor: ${converted.sort().join(', ')}.`
      : '',
    tables.length
      ? `\n\nCounted as one declaration each, so a row deleted from inside one of them does not show up here: ${tables.join(', ')}.`
      : '',
  ].join('');

  if (after >= before) {
    return {
      ok: true,
      removed: 0,
      headline:
        after === before
          ? `The test count holds at ${after}`
          : `The test count rises from ${before} to ${after}`,
      detail: `Test declarations, counted from the sources at both commits.${aside}`,
    };
  }

  const lost = before - after;
  const losses = [...new Set([...Object.keys(left.counts), ...Object.keys(right.counts)])]
    .filter((path) => !excluded.has(path))
    .map((path) => [path, (left.counts[path] ?? 0) - (right.counts[path] ?? 0)])
    .filter(([, delta]) => delta > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([path, delta]) => `- \`${path}\`: ${delta} fewer`)
    .join('\n');

  if (ACKNOWLEDGEMENT.test(String(body))) {
    return {
      ok: true,
      removed: lost,
      headline: `${lost} ${lost === 1 ? 'test is' : 'tests are'} removed, and the pull request says so`,
      detail: `${before} on the base, ${after} here. The body carries a \`Removes tests:\` line, which is the whole of what this check asks — it does not judge the reason.\n\n${losses}${aside}`,
    };
  }

  return {
    ok: false,
    removed: lost,
    headline: `${lost} ${lost === 1 ? 'test disappears' : 'tests disappear'} and nothing says why`,
    detail: `${before} tests on the base, ${after} here.\n\n${losses}\n\nRemoving a test can be right: a deleted feature takes its tests with it. What is not right is removing one by accident — a conflict resolution can drop assertions, including the ones proving a fix that had just merged, and every check stays green.\n\nIf the removal is deliberate, put a line in the pull request body beginning \`Removes tests:\` saying which and why — on that line or on the one below it, a bullet list underneath is fine. If it is not, this check has just caught it.${aside}`,
  };
}

/**
 * Read a tree's test files straight out of git, at any commit, without
 * checking it out. Here rather than in the workflow so the whole check is one
 * script with one set of tests.
 */
export async function treeAt(ref) {
  const { execFileSync } = await import('node:child_process');
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const paths = git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(isTestFile);
  const files = {};
  for (const path of paths) files[path] = git(['show', `${ref}:${path}`]);
  return census(files);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    console.error('usage: node scripts/test-census.mjs <base-ref> <head-ref>');
    process.exit(2);
  }

  const verdict = censusVerdict({
    base: await treeAt(baseRef),
    head: await treeAt(headRef),
    // The body is read for one fixed pattern and never interpolated into a
    // shell, a prompt, or this script's own output.
    body: process.env['PR_BODY'] ?? '',
  });

  const block = `### ${verdict.headline}\n\n${verdict.detail}\n`;
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(summary, `${block}\n`);
  }
  console.log(block);

  if (!verdict.ok) {
    console.log(`::warning title=${verdict.headline}::${verdict.detail.split('\n')[0]}`);
    process.exit(1);
  }
}
