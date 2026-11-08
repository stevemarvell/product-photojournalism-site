// Decide which reviews a pull request is worth spending a session on.
//
// A review session on this repository's pull requests costs real money
// (measured from `total_cost_usd` in the execution logs), so running two of
// them on a typo adds up. But the way a path filter fails is a known shape:
// a deploy config's watch pattern naming one path and omitting a sibling
// means a change to the sibling deploys nothing and says nothing. An
// allow-list of "security-sensitive paths" would fail the same way and be
// just as quiet — a hardcoded credential can land in any file in the
// repository, and no allow-list predicts which.
//
// So this is a deny-list of one narrow category, and the category is chosen
// because the claim "this cannot move the line docs/data-governance.md draws"
// is structurally true of it rather than merely plausible:
//
//   Markdown is rendered by scripts/markdown.mjs, which HTML-escapes every
//   text node and attribute and drops any link whose scheme is not http(s),
//   mailto, a fragment, or a relative path. A .md file therefore cannot put
//   script on the docs site, and it reaches no other deployment.
//
// Three exceptions, each a file that is Markdown but is not only prose:
//
//   - docs/data-governance.md is where the security posture is written down.
//     A pull request that widens what it permits is a security change even
//     though not a line of code moved, so it gets the security review (and no
//     code review — there is no code in it).
//   - .claude/**  holds the rubrics these reviewers read. A change that guts
//     security-checker.md would otherwise skip its own review.
//   - .github/**  is CI. Nothing there is ever "just prose".
//
// Everything else that is not Markdown gets both reviews. Unknown input — an
// empty list, a failed API call — gets both reviews too: the failure mode this
// guards against is silence, so it fails towards spending money rather than
// towards saying nothing.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonical } from './paths.mjs';

export const GOVERNANCE = 'docs/data-governance.md';

/**
 * One spelling of a path, for every comparison in this file — and now in
 * scripts/test-census.mjs too, which is why it lives in scripts/paths.mjs.
 *
 * Case folding happens there and nowhere else, which is the point. A
 * comparison that lowercases in one place and not the next — an extension
 * test folding case, a directory-prefix test not — let
 * `.CLAUDE/agents/security-checker.md` skip both of its own reviews.
 * Re-exported rather than moved silently, so the test asserting this helper
 * directly keeps asserting it here.
 */
export { canonical } from './paths.mjs';

/**
 * True when a path is under `.github/workflows/`.
 *
 * Not part of the skip decision — a workflow change is already not prose. It
 * is reported separately because the job that checks a review actually ran
 * needs to know it: `claude-code-action` refuses to start a session when the
 * pull request changes the workflow file, and naming that rule for every
 * missing session regardless of whether it applied would blame the wrong
 * cause.
 */
export function isWorkflow(path) {
  return canonical(path).startsWith('.github/workflows/');
}

/**
 * True when a path is prose that no deployment can execute. Deliberately
 * narrow: see the three exceptions in this file's header.
 */
export function isProse(path) {
  const clean = canonical(path);
  if (!clean.endsWith('.md')) return false;
  if (clean.startsWith('.claude/') || clean.startsWith('.github/')) return false;
  return true;
}

/**
 * Which reviews to run, given the paths a pull request changes.
 *
 * Returns `code` and `security` booleans, a `workflows` boolean saying
 * whether the pull request touches `.github/workflows/`, and a `why` line for
 * the log — the
 * decision is only useful if the run that acted on it says what it decided.
 */
export function reviewScope(paths) {
  const files = [...paths].map((path) => String(path).trim()).filter(Boolean);

  if (files.length === 0) {
    return {
      code: true,
      security: true,
      workflows: false,
      why: 'No file list was available, so both reviews run. A scope step that cannot read the diff must not be the reason a change goes unreviewed.',
    };
  }

  const workflows = files.some(isWorkflow);
  const code = files.filter((path) => !isProse(path));
  const governance = files.filter((path) => canonical(path) === GOVERNANCE);

  if (code.length > 0) {
    return {
      code: true,
      security: true,
      workflows,
      why: `${code.length} of ${files.length} changed files are not prose (${code.slice(0, 5).join(', ')}${code.length > 5 ? ', …' : ''}), so both reviews run.`,
    };
  }

  if (governance.length > 0) {
    return {
      code: false,
      security: true,
      workflows,
      why: `Every changed file is Markdown, but ${GOVERNANCE} is among them — that file is the security posture, so the security review runs and the code review does not.`,
    };
  }

  return {
    code: false,
    security: false,
    workflows,
    why: `All ${files.length} changed files are Markdown outside .claude/ and .github/. scripts/markdown.mjs escapes HTML and refuses unsafe URL schemes, so none of this reaches a deployment as anything but text. Both reviews skipped.`,
  };
}

/** Read the whole of stdin, so the caller can pipe `gh api ... --jq` into us. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const scope = reviewScope((await readStdin()).split('\n'));
  const output = process.env['GITHUB_OUTPUT'];
  if (output) {
    appendFileSync(
      output,
      `code=${scope.code}\nsecurity=${scope.security}\nworkflows=${scope.workflows}\n`,
    );
  }
  console.log(`code review: ${scope.code}`);
  console.log(`security review: ${scope.security}`);
  console.log(`touches .github/workflows/: ${scope.workflows}`);
  console.log(scope.why);
}
