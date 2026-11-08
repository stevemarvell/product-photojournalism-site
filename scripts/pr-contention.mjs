// Say when two open pull requests cannot both land — before one of them does.
//
// Two branches can point at the same line of the same file while both are
// open, and GitHub will report both as `mergeable=MERGEABLE`. Both answers
// are true, and both are useless: mergeability is computed against `develop`
// and never against the other pull request, so two branches that cannot both
// land look exactly like two that can. Merging one flips the other to
// CONFLICTING within seconds — with no notification, and nothing in CI
// re-running. The signal exists only if somebody happens to look at the
// other pull request.
//
// This closes that. Every pull request event, and every push to `develop`,
// three-way merges each open head against the base tip and against every other
// open head, and says what it finds on the pull request itself. Two answers
// that GitHub does not give:
//
//   - before a merge: "this and #<n> both change these files and conflict"
//   - after one: "#<n> landed and this no longer merges"
//
// Both sides of a collision are told, not just the pull request whose event
// fired. Reporting only the trigger leaves the earlier pull request blind —
// it gets no event of its own when a rival appears.
//
// WHY `merge-tree`. `git merge-tree --write-tree` does a real three-way merge
// against a real merge base and writes only to the object store, so this needs
// no working tree, no checkout per pair, and no guessing from overlapping diff
// hunks. Overlapping hunks are neither necessary nor sufficient for a conflict
// and a check built on them would be wrong in both directions.
//
// WHAT IT CANNOT SEE, and the reason it says so in its own output: a collision
// with no textual overlap at all. One branch can add a field to a response,
// another can pin that response's exact JSON, in different files by different
// agents; the merge is clean both ways and the second merge breaks the first's
// new check. Two branches sharing a *contract* is the harder case than two
// sharing a file, and no merge does arithmetic on it. CI catches those, after
// the fact, which is why this check reports rather
// than blocks.
import { pathToFileURL } from 'node:url';
import { isTestFile } from './test-census.mjs';

/**
 * How many open pull requests this will reason about in one run.
 *
 * SOP 1: the loop here is pairwise, so the cost is quadratic — twelve open
 * pull requests is sixty-six merges, and the number above that is where a
 * cheap check stops being cheap. Reaching the ceiling is reported in the
 * output rather than silently trimming the comparison, because a check that
 * quietly stopped covering half the queue is this repository's signature
 * defect wearing a different hat.
 */
export const MAX_PULL_REQUESTS = 12;

/**
 * The marker that lets a later run find and edit its own comment instead of
 * posting a second one. Invisible in rendered Markdown.
 */
export const MARKER = '<!-- pr-contention -->';

/**
 * The conflicted paths from `git merge-tree --write-tree --name-only`.
 *
 * Exit 0 is a clean merge. Exit 1 is *either* conflicts or the merge refusing
 * to run — git answers `not something we can merge` with exit 1 as well, which
 * is how an unfetched head presents, and that is the likeliest failure here by
 * some distance. Trusting the exit code alone read it as "conflicts: none",
 * which this check would then have printed as "merges cleanly" on the strength
 * of git having failed. Caught by running it against a real repository with a
 * head that was not there; the unit test passed throughout.
 *
 * So the discriminator is the output, not the status. A merge that ran writes
 * the resulting tree's oid on the first line, then the conflicted file names,
 * then a blank line and informational messages. No oid means no merge.
 */
const OID = /^[0-9a-f]{40,64}$/;

export function parseMergeTree(status, stdout) {
  if (status === 0) return { ok: true, conflicts: [] };

  const text = String(stdout ?? '');
  const [first, ...rest] = text.split('\n');
  if (status !== 1 || !OID.test(first.trim())) {
    return { ok: false, conflicts: [], failed: true };
  }

  const conflicts = [];
  for (const line of rest) {
    if (line.trim() === '') break;
    conflicts.push(line.trim());
  }
  return { ok: false, conflicts };
}

/**
 * Three-way merge two commits without touching a working tree.
 *
 * `run` is injected so the decision logic above can be tested without a
 * repository; the default shells out to git.
 */
export async function mergeConflicts(a, b, run) {
  const exec =
    run ??
    (async (args) => {
      const { execFile } = await import('node:child_process');
      return await new Promise((resolve) => {
        execFile('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
          resolve({ status: error?.code ?? 0, stdout: String(stdout ?? '') }),
        );
      });
    });

  const result = await exec(['merge-tree', '--write-tree', '--name-only', String(a), String(b)]);
  return parseMergeTree(result.status, result.stdout);
}

/**
 * Split conflicted paths into the ones git can arbitrate and the ones it
 * cannot.
 *
 * A conflict in source has a right answer somewhere in the two sides. A
 * conflict in a *test* file usually does not: two branches can each add a
 * test at the same anchor, so both sides are additions, and the resolution
 * git offers is a choice between them where the correct answer is the union
 * of them. Taking one side leaves the behaviour correct, the suite green,
 * and an assertion gone.
 *
 * `isTestFile` comes from test-census.mjs rather than a second regular
 * expression here, for the reason paths.mjs exists: the moment two files
 * disagree about what a test file is, one of them is silently covering less
 * than it claims.
 */
export function partitionConflicts(paths) {
  const all = (paths ?? []).map(String);
  return {
    tests: all.filter((path) => isTestFile(path)),
    sources: all.filter((path) => !isTestFile(path)),
  };
}

/**
 * Which open pull requests this run compares, and whether it had to stop
 * short.
 */
export function selectPullRequests(list, max = MAX_PULL_REQUESTS) {
  const open = (list ?? []).filter((pr) => Number.isInteger(pr?.number));
  // Oldest first: a queue is worked from the front, so when the ceiling bites
  // it should drop the pull requests least likely to merge next.
  const ordered = [...open].sort((a, b) => a.number - b.number);
  return { selected: ordered.slice(0, max), truncated: Math.max(0, ordered.length - max) };
}

/**
 * Every pull request this run reports on.
 *
 * **Both sides of a collision, not just the one whose event fired.** Reporting
 * only on the triggering pull request makes the pre-merge warning one-sided:
 * a pull request already open when a rival appears gets no event of its
 * own, so it is never told. The author who most needs the warning is the
 * one at risk of not getting it — the pull request that is about to lose a
 * race it was never told it was in.
 *
 * Reporting on every selected pull request costs nothing extra in merges: the
 * pairwise matrix is already computed and already bounded by
 * MAX_PULL_REQUESTS. It costs no noise either, because `commentAction` writes
 * nothing for a pull request whose verdict is clean and unchanged.
 *
 * A pull request named on the command line is included even when the ceiling
 * would have dropped it: the one whose event triggered the run must never
 * fall out silently.
 */
export function reportingTargets(open, only = []) {
  const { selected } = selectPullRequests(open);
  const byNumber = new Map(selected.map((pr) => [pr.number, pr]));
  for (const number of only) {
    if (byNumber.has(number)) continue;
    const pr = (open ?? []).find((candidate) => candidate.number === number);
    if (pr) byNumber.set(number, pr);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * The heads a run needs fetched: exactly the pull requests it will report on.
 *
 * Derived from `reportingTargets` rather than computed alongside it, so the
 * two cannot disagree. They did once — the fetch list came from the ceiling's
 * selection while the reported-on subject did not, and past the ceiling the
 * triggering pull request was compared against a head that was never there.
 */
export function refsToFetch(open, only = []) {
  return reportingTargets(open, only).map((pr) => `refs/pull/${pr.number}/head`);
}

const list = (paths) => paths.map((path) => `\`${path}\``).join(', ');

/**
 * What to say about one pull request, given how it merges against the base tip
 * and against each of its open siblings.
 *
 * `base.conflicts` is the post-merge case — something landed and this no
 * longer applies. `rivals` is the pre-merge one, which is the answer GitHub
 * does not compute: each entry is another open pull request and the paths the
 * two of them cannot both have.
 */
export function contentionVerdict({ subject, base, rivals = [], truncated = 0 } = {}) {
  const me = `#${subject?.number ?? '?'}`;
  const colliding = rivals.filter((rival) => rival?.conflicts?.length > 0);
  const baseConflicts = base?.conflicts ?? [];
  const compared = rivals.length;
  // A merge that could not run has no conflicts to report, which is the same
  // shape as a merge that ran and found none. Reading the first as the second
  // would print "merges cleanly" on the strength of git having failed — the
  // reassuring answer arriving exactly when this knows least, which is the
  // defect SOP 3 exists for and the one this whole check is descended from.
  const unknown = [
    ...(base?.failed ? [`\`${base.ref ?? 'the base branch'}\``] : []),
    ...rivals.filter((rival) => rival?.failed).map((rival) => `#${rival.number}`),
  ];

  const ceiling = truncated
    ? `\n\n${truncated} further open pull ${truncated === 1 ? 'request was' : 'requests were'} not compared: this check stops at ${MAX_PULL_REQUESTS} because the comparison is pairwise. Re-run it once the queue is shorter.`
    : '';

  // Stated on every verdict, including the clean one. A reader who takes "no
  // contention" as "these can both land" has been told something this check
  // cannot establish.
  const blindSpot =
    '\n\nA clean merge is not the same as a compatible change. Two branches can share a contract without sharing a line — one can add a field to a response, another can pin that response\'s exact shape, they merge cleanly in both directions and the second one still breaks the first. Only CI sees that.';

  // Contention found elsewhere does not excuse a comparison that did not run.
  const uncertainty = unknown.length
    ? `\n\nSeparately, \`git merge-tree\` did not run against ${unknown.join(', ')}, so those comparisons are unknown rather than clean.`
    : '';

  const testWarning = (paths) => {
    const { tests } = partitionConflicts(paths);
    if (tests.length === 0) return '';
    return `\n\n**${tests.length === 1 ? 'One of these is a test file' : 'Some of these are test files'}: ${list(tests)}.** Resolve test conflicts as a union, not a choice. Where two branches each *added* a test at the same anchor, both additions are correct and git can only offer you one of them — taking a side leaves the behaviour correct, the suite green, and an assertion silently gone. The \`test census\` check counts both sides and will notice if the total falls.`;
  };

  if (unknown.length > 0 && baseConflicts.length === 0 && colliding.length === 0) {
    return {
      ok: false,
      state: 'unknown',
      headline: `Whether ${me} collides with anything could not be established`,
      detail: `\`git merge-tree\` did not run against ${unknown.join(', ')} — a missing object, an unfetched head, or histories with no merge base. That is not the same as a clean merge and is not reported as one.\n\nNothing here is known to be wrong with ${me}. Nothing here is known to be right with it either: re-run this check, and if it keeps saying this, the fetch step is the place to look.${blindSpot}${ceiling}`,
    };
  }

  if (baseConflicts.length > 0) {
    const also = colliding.length
      ? `\n\nStill open and also in contention with this one: ${colliding.map((rival) => `#${rival.number} (${list(rival.conflicts)})`).join(', ')}.`
      : '';
    return {
      ok: false,
      state: 'base',
      headline: `${me} no longer merges into ${base?.ref ?? 'the base branch'}`,
      detail: `Something landed on \`${base?.ref ?? 'the base branch'}\` that this branch cannot merge with. Conflicting: ${list(baseConflicts)}.\n\nGitHub flips the pull request to \`CONFLICTING\` when this happens and tells nobody — no notification, no check re-run. This comment is the notification.\n\nMerge the base branch in and resolve it. Do not rebase a branch someone else may have checked out.${testWarning(baseConflicts)}${also}${uncertainty}${blindSpot}${ceiling}`,
    };
  }

  if (colliding.length > 0) {
    const rows = colliding
      .map((rival) => `- **#${rival.number}** ${rival.title ?? ''} — ${list(rival.conflicts)}`)
      .join('\n');
    const allPaths = colliding.flatMap((rival) => rival.conflicts);
    return {
      ok: false,
      state: 'rivals',
      headline: `${me} and ${colliding.length === 1 ? 'one other open pull request cannot' : `${colliding.length} other open pull requests cannot`} both land as ${colliding.length === 1 ? 'they are' : 'things stand'}`,
      detail: `Both this and the pull ${colliding.length === 1 ? 'request' : 'requests'} below merge into \`${base?.ref ?? 'the base branch'}\` cleanly today, so GitHub reports every one of them \`MERGEABLE\`. They conflict with **each other**, which GitHub does not compute:\n\n${rows}\n\nWhichever merges first is fine. The others will flip to \`CONFLICTING\` the moment it does, so whoever goes second is resolving this by hand. Deciding now which change is the better one is cheaper than discovering it during a rebase.${testWarning(allPaths)}${uncertainty}${blindSpot}${ceiling}`,
    };
  }

  return {
    ok: true,
    state: 'clear',
    headline: `${me} merges cleanly against \`${base?.ref ?? 'the base branch'}\` and against ${compared === 0 ? 'no other open pull request' : compared === 1 ? '1 other open pull request' : `${compared} other open pull requests`}`,
    detail: `Checked with a real three-way merge per pair, not by comparing diff hunks.${blindSpot}${ceiling}`,
  };
}

/** The comment body for a verdict, carrying the marker that finds it again. */
export function commentBody(verdict) {
  return `${MARKER}\n### ${verdict.headline}\n\n${verdict.detail}\n`;
}

/**
 * Post, edit, or leave alone.
 *
 * Three rules, all of them about not becoming noise. An unchanged verdict
 * writes nothing, so a run per push does not produce a comment per push. A
 * clean verdict posts nothing *unless* this check has already warned on the
 * pull request, in which case the warning is replaced by a note saying it
 * cleared — a stale conflict warning left standing is worse than none, because
 * the next reader resolves a conflict that is not there.
 */
export function commentAction({ existing = null, verdict } = {}) {
  const body = verdict.ok
    ? `${MARKER}\n### ${verdict.headline}\n\nAn earlier run of this check reported contention here. It has cleared.\n`
    : commentBody(verdict);

  if (verdict.ok && !existing) return null;
  if (existing && existing.body?.trim() === body.trim()) return null;
  return existing ? { method: 'PATCH', id: existing.id, body } : { method: 'POST', body };
}

const gh = async (args, input) => {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = execFile(
      'gh',
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve({ status: error?.code ?? 0, stdout: String(stdout ?? '') }),
    );
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
};

/** The existing comment from this check on a pull request, if there is one. */
async function findComment(repository, number) {
  const { status, stdout } = await gh([
    'api',
    `repos/${repository}/issues/${number}/comments`,
    '--paginate',
    '--jq',
    `[.[] | select(.body | contains("${MARKER}")) | {id, body}] | last // empty`,
  ]);
  if (status !== 0 || stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

async function writeSummary(block) {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (!summary) return;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summary, `${block}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const open = JSON.parse(process.env['OPEN_PRS'] ?? '[]');
  const { selected, truncated } = selectPullRequests(open);

  // `--refs` exists so the ceiling is declared once. The workflow asks this
  // script which pull request heads to fetch rather than deciding for itself,
  // which keeps MAX_PULL_REQUESTS from being restated in YAML where it would
  // drift.
  if (args[0] === '--refs') {
    const wanted = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
    for (const ref of refsToFetch(open, wanted)) console.log(ref);
    process.exit(0);
  }

  const baseRef = process.env['BASE_REF'] || 'develop';
  const baseSha = process.env['BASE_SHA'];
  const repository = process.env['GITHUB_REPOSITORY'] ?? '';
  const dryRun = args.includes('--dry-run') || !process.env['GH_TOKEN'];
  // Every selected pull request, not only the one whose event fired — see
  // `reportingTargets`. Writing a verdict for each is what makes the warning
  // reach both sides of a collision; the quiet ones stay quiet because
  // `commentAction` suppresses an unchanged clean verdict.
  const only = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
  const subjects = reportingTargets(open, only);

  if (!baseSha) {
    console.error('BASE_SHA is required');
    process.exit(2);
  }

  let contended = 0;
  for (const subject of subjects) {
    const base = { ref: baseRef, ...(await mergeConflicts(baseSha, subject.headRefOid)) };
    const rivals = [];
    for (const other of selected) {
      if (other.number === subject.number) continue;
      const merged = await mergeConflicts(subject.headRefOid, other.headRefOid);
      rivals.push({
        number: other.number,
        title: other.title,
        conflicts: merged.conflicts,
        failed: merged.failed,
      });
    }

    const verdict = contentionVerdict({ subject, base, rivals, truncated });
    const block = `### ${verdict.headline}\n\n${verdict.detail}\n`;
    await writeSummary(block);
    console.log(block);
    if (!verdict.ok) contended += 1;

    const existing = dryRun ? null : await findComment(repository, subject.number);
    const action = commentAction({ existing, verdict });
    if (!action || dryRun) continue;

    const target =
      action.method === 'POST'
        ? `repos/${repository}/issues/${subject.number}/comments`
        : `repos/${repository}/issues/comments/${action.id}`;
    const { status } = await gh(
      ['api', '--method', action.method, target, '--input', '-'],
      JSON.stringify({ body: action.body }),
    );
    if (status !== 0) console.log(`::warning::could not write the contention comment on #${subject.number}`);
  }

  // Exit 0 even when contention is found. This reports; it does not block.
  // A pull request that collides with another is not wrong — one of them is
  // going to merge — and a red check on both would be a red check nobody can
  // clear without the other author.
  if (contended > 0) {
    console.log(`::notice title=Pull request contention::${contended} of ${subjects.length} open pull requests are in contention`);
  }
}
