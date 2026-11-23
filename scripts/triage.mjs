// Decide which open issues an agent should work, and in what order.
//
// This is the "dynamic" half of step 3: the work is chosen from repository
// state rather than written in advance. The choice is still made by fixed
// rules, not by judgement, so that it can be tested and read back:
//
// 1. First skip an issue not written by the owner or someone with write access:
//    the repository is public, so anyone can open one (`trusted`). This runs
//    before every other skip, so a stranger's title is never printed, whatever
//    labels the issue carries. Then skip anything a person owns: `human`, `do not automate`, or any
//    `blocked…` label (CLAUDE.md: work that needs a person is labelled, not
//    attempted). Skip a `template` too: it is a blank scaffold a person
//    copies, and filling it in is never an agent's job (CLAUDE.md).
// 2. Skip anything already in flight: an open pull request whose body names
//    the issue with Closes/Fixes/Resolves/Refs.
// 3. Skip anything whose body says "Depends on #<n>" for an issue still open.
// 4. Defer an issue that is not ready to brief: no `**Then**` line under
//    `## Acceptance criteria`, or an empty `## Details to complete`
//    (`readiness`). It is listed as `Not ready` for the coordinator to
//    complete (work-backlog step 1), is never also skipped, and does not
//    count as work.
//    An issue carrying two comments marked `<!-- backlog-attempt -->` (one per
//    failed attempt, written by the work-backlog loop) is skipped too, whatever
//    its labels: the per-issue bound lives on the issue, so a resumed run
//    cannot lose it (`attemptsOf`, #395).
// 5. Order the rest by the one scale (SOP 5): critical, high, medium, then
//    unranked. Within a rank, `security` first, then oldest first.
// 6. No count limit: `work` is every workable issue. A run's declared maximum
//    (SOP 1) is the usage window, not a number of issues: the skill keeps
//    re-triaging until this list is empty or usage nears its limit.
//
// The `work-backlog` skill runs this, works what it picks, and runs it again
// after each merge — so a merge that closes an issue, or a smoke failure that
// opens one, changes what comes next.
//
// Reads GitHub through REST (`gh api`), never `gh issue list` or `gh pr list`:
// those go through GraphQL, which Claude Code cloud sessions refuse (#225).
// REST's issues listing carries open pull requests too (an entry with a
// `pull_request` key), so one paged listing yields both lists.
//
// Usage: node scripts/triage.mjs [--json]   (prints the plan; changes nothing)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Items per REST page; GitHub's maximum. */
export const PAGE_SIZE = 100;

/** Pages of open issues and pull requests read before stopping. Hitting it is reported (SOP 1). */
export const MAX_PAGES = 4;

/** The most open issues and pull requests, together, one run reads. Hitting it is reported. */
export const FETCH_LIMIT = PAGE_SIZE * MAX_PAGES;

/** The first line of the comment the loop leaves on an issue when its implementer ends with no pull request. */
export const ATTEMPT_MARKER = '<!-- backlog-attempt -->';

/** Recorded failed attempts after which an issue is no longer picked. */
export const MAX_ATTEMPTS = 2;

const RANK = { critical: 0, high: 1, medium: 2 };
const UNRANKED = 3;

const PERSON = (label) => label === 'human' || label === 'do not automate' || label.startsWith('blocked');

/** Repository permissions that let an author steer the loop. */
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

/**
 * Whether an agent may act on this issue. `author_association` OWNER is
 * trusted outright. MEMBER and COLLABORATOR do not imply write access (a
 * collaborator can hold read or triage), so for those the author's permission
 * on the repository must be admin, maintain or write, read through
 * `permissionOf(login)`. Anything else, a missing login, a missing
 * `permissionOf` or a lookup that throws, is held: fail closed. A rank label
 * does not count, because a stranger can edit an issue's body after it is
 * ranked. A stranger's report is worked when the owner opens an issue of
 * their own with its content.
 */
export function trusted(issue, permissionOf) {
  const association = issue.authorAssociation;
  if (association === 'OWNER') return true;
  if (association !== 'MEMBER' && association !== 'COLLABORATOR') return false;
  const login = issue.user?.login;
  if (!login || typeof permissionOf !== 'function') return false;
  try {
    return WRITE_PERMISSIONS.has(permissionOf(login));
  } catch {
    return false;
  }
}

/** Issue numbers an open pull request already claims. */
export function claimedIssues(pullRequests) {
  const claimed = new Map();
  const pattern = /\b(?:closes|fixes|resolves|refs)\s+#(\d+)/gi;
  for (const pr of pullRequests) {
    for (const match of (pr.body ?? '').matchAll(pattern)) {
      claimed.set(Number(match[1]), pr.number);
    }
  }
  return claimed;
}

/** Open issues this issue's body says it depends on. */
export function openDependencies(issue, openNumbers) {
  const deps = [...(issue.body ?? '').matchAll(/depends on #(\d+)/gi)].map((m) => Number(m[1]));
  return deps.filter((n) => openNumbers.has(n));
}

// Own properties only: a label named `constructor` or `toString` would
// otherwise read Object.prototype's, rank as NaN, and break the sort.
function rankOf(labels) {
  return Math.min(UNRANKED, ...labels.map((l) => (Object.hasOwn(RANK, l) ? RANK[l] : UNRANKED)));
}

/** The body's `## ` sections by exact heading, with fenced code blocks and CRLF removed. */
function sections(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '');
  const out = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) {
      current = line.slice(3).trimEnd();
      if (!out.has(current)) out.set(current, []);
    } else if (current !== null) {
      out.get(current).push(line);
    }
  }
  return out;
}

/** A real `**Then**` line: not a `_` line, and not the template's bracketed placeholder or `...`. */
function hasThen(line) {
  if (line.startsWith('_')) return false;
  const match = /\*\*Then\*\*(.*)$/.exec(line);
  if (!match) return false;
  const text = match[1].trim();
  return text !== '' && text !== '...' && !/^\[[^\]]*\]$/.test(text);
}

/**
 * Whether an issue can be briefed as it stands: null if so, else the reason it
 * cannot. Reads structure only, never acts on the text. The sections are those
 * of `.github/ISSUE_TEMPLATE/story.md`; the template's placeholder lines start
 * with `_` and are ignored, as is a bare `1.`. A details section of `None` is
 * ready.
 */
export function readiness(issue) {
  const found = sections(issue.body);
  const criteria = (found.get('Acceptance criteria') ?? []).filter((l) => hasThen(l));
  if (criteria.length === 0) return 'no acceptance criteria';
  const details = (found.get('Details to complete') ?? []).map((l) => l.trim()).filter((l) => l && !l.startsWith('_') && !/^1\.$/.test(l));
  if (details.length === 0) return 'no details to complete';
  return null;
}

/**
 * @param issues        [{ number, title, labels: string[], body, user: { login }, authorAssociation }]
 * @param pullRequests  open PRs: [{ number, body }]
 * @param permissionOf (login) => the author's repository permission; see `trusted`
 * @param attemptsOf   (number) => count of `ATTEMPT_MARKER` comments on the issue; read only for an issue that is otherwise workable
 * @returns {{ work, notReady, skip }} work is every workable issue, in order
 */
export function triage(issues, pullRequests, permissionOf = undefined, attemptsOf = undefined) {
  const openNumbers = new Set(issues.map((i) => i.number));
  const claimed = claimedIssues(pullRequests);
  const eligible = [];
  const skip = [];
  const notReady = [];

  for (const issue of issues) {
    if (!trusted(issue, permissionOf)) {
      // A stranger's title is text the loop would otherwise print: leave it out.
      skip.push({
        number: issue.number,
        reason: 'not written by the owner or someone with write access',
        author: issue.user?.login ?? 'unknown',
        association: issue.authorAssociation ?? 'unknown',
      });
      continue;
    }
    if (issue.labels.includes('template')) {
      skip.push({ number: issue.number, title: issue.title, reason: 'a template, copied by a person' });
      continue;
    }
    const person = issue.labels.filter(PERSON);
    if (person.length) {
      skip.push({ number: issue.number, title: issue.title, reason: `needs a person (${person.join(', ')})` });
      continue;
    }
    if (claimed.has(issue.number)) {
      skip.push({ number: issue.number, title: issue.title, reason: `in flight in #${claimed.get(issue.number)}` });
      continue;
    }
    const deps = openDependencies(issue, openNumbers);
    if (deps.length) {
      skip.push({ number: issue.number, title: issue.title, reason: `depends on open ${deps.map((n) => `#${n}`).join(', ')}` });
      continue;
    }
    const reason = readiness(issue);
    if (reason) {
      notReady.push({ number: issue.number, title: issue.title, reason });
      continue;
    }
    const attempts = attemptsOf ? attemptsOf(issue.number) : 0;
    if (attempts >= MAX_ATTEMPTS) {
      skip.push({
        number: issue.number,
        title: issue.title,
        reason: `${attempts} failed attempts recorded on the issue; label it human and do not automate`,
      });
      continue;
    }
    eligible.push({
      number: issue.number,
      title: issue.title,
      attempts,
      rank: rankOf(issue.labels),
      security: issue.labels.includes('security'),
    });
  }

  eligible.sort((a, b) => a.rank - b.rank || Number(b.security) - Number(a.security) || a.number - b.number);
  const ordered = eligible.map(({ number, title, rank, attempts }) => ({
    number,
    title,
    attempts,
    rank: Object.keys(RANK)[rank] ?? 'unranked',
  }));
  return {
    work: ordered,
    notReady: notReady.sort((a, b) => a.number - b.number),
    skip: skip.sort((a, b) => a.number - b.number),
  };
}

/** The plan as text, for a person or a pull request body to read. */
export function render({ work, notReady = [], skip }, { truncated = false } = {}) {
  const lines = ['Work, in order (re-triage after every merge; stop when this is empty):'];
  if (work.length === 0) lines.push('  nothing an agent may take on');
  for (const w of work) lines.push(`  #${w.number} [${w.rank}] ${w.title}${w.attempts ? ` (${w.attempts} failed attempt recorded: a second one makes it human)` : ''}`);
  if (notReady.length) {
    lines.push('Not ready (complete the issue before briefing):');
    for (const n of notReady) lines.push(`  #${n.number} ${n.reason}: ${n.title}`);
  }
  lines.push('Skip:');
  for (const s of skip) {
    const reason = s.author ? `opened by ${s.author} (${s.association}); copy it into an owner issue to work it` : s.reason;
    lines.push(s.author ? `  #${s.number} ${reason}` : `  #${s.number} ${reason}: ${s.title}`);
  }
  if (truncated) lines.push(`WARNING: a listing hit ${FETCH_LIMIT} results; the plan may be incomplete.`);
  return lines.join('\n') + '\n';
}

/** Runs `gh` and returns its stdout; throws with gh's own message on failure. */
export function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} failed: ${String(error.stderr ?? '').trim() || error.message}`);
  }
}

/**
 * Every open issue and open pull request, read from REST's issues listing a
 * page at a time. `run(args)` returns gh's stdout and throws on failure; it
 * is injected so a test makes no network calls. Stops at `maxPages` and says
 * so in `truncated` rather than passing a partial list off as the whole one.
 *
 * @returns {{ issues, pullRequests, truncated }}
 */
export function fetchOpen(run = gh, maxPages = MAX_PAGES) {
  const issues = [];
  const pullRequests = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = JSON.parse(run(['api', `repos/{owner}/{repo}/issues?state=open&per_page=${PAGE_SIZE}&page=${page}`]));
    for (const item of items) {
      if (item.pull_request) {
        pullRequests.push({ number: item.number, body: item.body });
      } else {
        issues.push({
          number: item.number,
          title: item.title,
          body: item.body,
          user: { login: item.user?.login },
          authorAssociation: item.author_association,
          labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
        });
      }
    }
    if (items.length < PAGE_SIZE) return { issues, pullRequests, truncated: false };
  }
  // The last allowed page was full. Truncated only if one more item exists
  // beyond it: ask for exactly the next one.
  const beyond = JSON.parse(run(['api', `repos/{owner}/{repo}/issues?state=open&per_page=1&page=${maxPages * PAGE_SIZE + 1}`]));
  return { issues, pullRequests, truncated: beyond.length > 0 };
}

/**
 * `permissionOf` for the CLI: the author's permission on this repository from
 * REST (`collaborators/<login>/permission`), cached per login. A failed lookup
 * throws, and `trusted` holds the issue.
 */
export function permissionLookup(run = gh) {
  const cache = new Map();
  return (login) => {
    if (!cache.has(login)) {
      const permission = JSON.parse(run(['api', `repos/{owner}/{repo}/collaborators/${encodeURIComponent(login)}/permission`])).permission;
      cache.set(login, permission);
    }
    return cache.get(login);
  };
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

/** The jq condition "authored by one of these logins". Throws on a login that is not one, or on none. */
export function authorClause(logins) {
  if (!logins.length || !logins.every((l) => typeof l === 'string' && LOGIN.test(l))) throw new Error('not a GitHub login');
  return `(${logins.map((l) => `.user.login == "${l}"`).join(' or ')})`;
}

/** The loop identity from `--login <name>` or `--login=<name>`, else `BACKLOG_LOGIN`, else undefined. */
export function loginOption(argv = process.argv, env = process.env) {
  const at = argv.indexOf('--login');
  const eq = argv.find((a) => a.startsWith('--login='));
  return (at > 0 ? argv[at + 1] : eq?.slice('--login='.length)) || env.BACKLOG_LOGIN || undefined;
}

/**
 * The logins whose comments steer the loop: the repository owner's, this
 * session's own when `gh api user` answers, and the configured loop identity
 * (`options.login`, from `--login` or `BACKLOG_LOGIN`) when given. An
 * installation or GITHUB_TOKEN credential has no user, so that lookup failing
 * falls back to the owner and the configured login, and says so on
 * `options.warn` (stderr by default): a loop commenting as a bot would
 * otherwise go uncounted without a word.
 */
export function trustedLogins(run = gh, { login, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const owner = run(['api', 'repos/{owner}/{repo}', '--jq', '.owner.login']).trim();
  let session = '';
  try {
    session = run(['api', 'user', '--jq', '.login']).trim();
  } catch {
    warn(
      `warning: gh api user failed; counting comments by ${[owner, login].filter(Boolean).join(' and ')} only` +
        (login ? '' : ' (set --login <name> or BACKLOG_LOGIN if the loop comments as another login)'),
    );
  }
  return [...new Set([owner, session, login].filter(Boolean))];
}

/**
 * `attemptsOf` for the CLI: how many comments by a trusted login start with
 * `ATTEMPT_MARKER`, counted inside `--jq` so no comment text is read and a
 * stranger's marker does not count. Pages print one count each; they are
 * summed. A failed lookup throws.
 */
export function attemptLookup(run = gh, logins = []) {
  const jq = `[.[] | select(${authorClause(logins)} and (.body | startswith("${ATTEMPT_MARKER}")))] | length`;
  return (number) => {
    const out = run(['api', '--paginate', `repos/{owner}/{repo}/issues/${number}/comments?per_page=100`, '--jq', jq]);
    return out.split('\n').filter(Boolean).reduce((sum, n) => sum + Number(n), 0);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { issues, pullRequests, truncated } = fetchOpen();
    const plan = triage(issues, pullRequests, permissionLookup(), attemptLookup(gh, trustedLogins(gh, { login: loginOption() })));
    process.stdout.write(
      process.argv.includes('--json') ? JSON.stringify({ ...plan, truncated }, null, 2) + '\n' : render(plan, { truncated }),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
