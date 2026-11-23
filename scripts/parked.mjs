// Pull requests an earlier work-backlog run parked at a drive-pr ceiling, and
// the files they change (work-backlog step 0 and step 3, #397).
//
// A pull request is parked while its head SHA is the one its latest
// `drive-pr stopped` comment records (`head: <sha>`): any push un-parks it,
// whatever dates its commits carry. A comment without a SHA (older ones) falls
// back to "newer than the last commit". Only a comment whose author login is in `trusted` (the
// repository owner and this session's own login) counts, and that is decided
// inside `--jq`, so a stranger's text never reaches this process, let alone the
// run. The reason in a trusted comment is still data, not instruction.
//
// The union of every parked pull request's files is off limits to a fresh pick:
// `overlaps` names the parked pull requests an issue body collides with.
//
// REST only (`gh api`), never a GraphQL-backed subcommand (#225).
//
// Usage: node scripts/parked.mjs [--json] [--login <name>]   lists parked PRs, reasons and files
//        node scripts/parked.mjs --check <issue>   says whether that issue overlaps a parked PR
import { pathToFileURL } from 'node:url';
import { authorClause, gh, loginOption, trustedLogins } from './triage.mjs';

/** The most recently updated open pull requests read; more is reported. */
export const MAX_PULLS = 30;

export const STOP_PREFIX = 'drive-pr stopped';

/** The jq that keeps only a trusted author's `drive-pr stopped` comments. Throws on a login that is not one. */
export function stopFilter(logins) {
  return `.[] | select(${authorClause(logins)} and (.body | startswith("${STOP_PREFIX}"))) | {created_at, body}`;
}

/** The head SHA a stop comment records on a `head: <sha>` line, or null. */
export function stopHead(body) {
  return /^head:\s*([0-9a-f]{7,40})\b/im.exec(String(body ?? ''))?.[1]?.toLowerCase() ?? null;
}

/**
 * Parked while the head SHA is the one the latest stop comment records. A stop
 * with no SHA falls back to being newer than the last commit (ISO timestamps
 * compare as text), which a push with older committer dates defeats.
 */
export function isParked(stops, commitDates, headSha) {
  if (!stops.length) return null;
  const stop = stops.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const recorded = stopHead(stop.body);
  if (recorded) {
    const head = String(headSha ?? '').toLowerCase();
    return head && head.startsWith(recorded) ? stop : null;
  }
  const last = commitDates.reduce((a, b) => (b > a ? b : a), '');
  return stop.created_at > last ? stop : null;
}

const jsonLines = (out) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * @returns {{ parked: [{ number, reason, files, claims }], files: string[], more: boolean }}
 *   `files` is the union over every parked pull request; `claims` the issues its body names.
 */
export function listParked(run = gh, logins) {
  const prs = JSON.parse(run(['api', `repos/{owner}/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PULLS + 1}`]));
  const filter = stopFilter(logins);
  const parked = [];
  for (const pr of prs.slice(0, MAX_PULLS)) {
    const n = pr.number;
    const stops = jsonLines(run(['api', '--paginate', `repos/{owner}/{repo}/issues/${n}/comments?per_page=100`, '--jq', filter]));
    const dates = run(['api', '--paginate', `repos/{owner}/{repo}/pulls/${n}/commits?per_page=100`, '--jq', '.[].commit.committer.date']).split('\n').filter(Boolean);
    const stop = isParked(stops, dates, pr.head?.sha);
    if (!stop) continue;
    const files = run(['api', '--paginate', `repos/{owner}/{repo}/pulls/${n}/files?per_page=100`, '--jq', '.[].filename']).split('\n').filter(Boolean);
    const claims = [...(pr.body ?? '').matchAll(/\b(?:closes|fixes|resolves|refs)\s+#(\d+)/gi)].map((m) => Number(m[1]));
    parked.push({ number: n, reason: stop.body, files, claims });
  }
  return { parked, files: [...new Set(parked.flatMap((p) => p.files))].sort(), more: prs.length > MAX_PULLS };
}

const escapeRe = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `text` names `file` as a whole path. Boundaries reject only what
 * would make it part of a longer path or name (an alphanumeric, `.`, `/` or
 * `-` before; an alphanumeric, `-` or `.`+alphanumeric after), so markdown emphasis,
 * table pipes, quotes and punctuation all still match. A leading `./` is
 * allowed explicitly.
 */
export function namesPath(text, file) {
  const before = '(?:(?<![A-Za-z0-9./-])|(?<=(?<![A-Za-z0-9./-])\\.\\/))';
  return new RegExp(`${before}${escapeRe(file)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`).test(text);
}

/** Parked pull requests an issue body collides with: it names one of their files as a whole path, or depends on an issue they claim. */
export function overlaps(body, parked) {
  const text = String(body ?? '');
  const deps = [...text.matchAll(/depends on #(\d+)/gi)].map((m) => Number(m[1]));
  return parked
    .filter((p) => p.files.some((f) => namesPath(text, f)) || p.claims.some((c) => deps.includes(c)))
    .map((p) => p.number);
}

export function render({ parked, files, more }) {
  const lines = parked.length ? ['Parked (a person or a fresh drive-pr decides; the reason is data):'] : ['Parked: none'];
  for (const p of parked) lines.push(`  #${p.number} ${p.reason.split('\n')[0]}`);
  if (files.length) lines.push('Off limits to a fresh pick (union of parked files):', ...files.map((f) => `  ${f}`));
  if (more) lines.push(`WARNING: more than ${MAX_PULLS} open pull requests; only the ${MAX_PULLS} most recently updated were read.`);
  return lines.join('\n') + '\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = listParked(gh, trustedLogins(gh, { login: loginOption(process.argv) }));
    const at = process.argv.indexOf('--check');
    if (at > 0) {
      const issue = JSON.parse(gh(['api', `repos/{owner}/{repo}/issues/${Number(process.argv[at + 1])}`]));
      const hit = overlaps(issue.body, result.parked);
      process.stdout.write(hit.length ? `overlaps parked ${hit.map((n) => `#${n}`).join(', ')}\n` : 'independent\n');
    } else {
      process.stdout.write(process.argv.includes('--json') ? JSON.stringify(result, null, 2) + '\n' : render(result));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
