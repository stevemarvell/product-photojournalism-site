#!/usr/bin/env node
// From an empty folder to a repository ready for triage.
//
// Copying files does not give a working repository: it also needs the
// secrets, labels, settings and owner tickets around them, and starting a real
// repository from this base took days of hand work before this existed.
//
// Usage:
//     node scripts/setup.mjs create --name <n> --owner <o> [--starter <s> ...]
//                                   [--deploy <provider>] [--dir <path>] [--public]
//     node scripts/setup.mjs add --starter <s> [--starter <s> ...]
//     node scripts/setup.mjs check [--skip-verify] [--dry-run] [--repo owner/name]
//
// Not `npm run setup -- ...`: on Windows, npm's PowerShell shim drops the `--`,
// npm takes the flags as its own config and strips them, and only the bare
// values reach this script (#276). `node` bypasses npm in every shell.
//
// `create` is run from a checkout of this base, and is never run for real by
// an agent: it creates a GitHub repository, which is the owner's call. It
// wraps scripts/assemble.mjs, which builds the file tree from catalogue.json;
// the product gets no history from this base, one commit of its own, and a
// fetch-only remote to it. Which base commit it was built from is recorded as
// `engine.commit` in the product's project.json.
// `add` is run inside a product, and adds starters to it: an engine-only
// product that now needs an app. It fetches the base at the product's
// `engine.commit` through the fetch-only remote `create` set up, so it adds
// the starter as that commit had it, not as the base's `develop` has it now.
// It plans with scripts/assemble.mjs, writes the starters' files and the app
// entries, and regenerates what assemble derives (package.json, dependabot.yml,
// README.md, CLAUDE.md), unless the product has rewritten that file, which
// it leaves and names. It refuses a dirty tree, an app path that exists, and
// an unknown starter, before it writes anything.
// `check` is run inside a repository built from this base (including this
// one) and is idempotent — re-running it after fixing something reports less
// to do, never more, and never creates a second copy of anything it already
// made. It exits 0 only when every line is done (✔) or just fixed (✚); any
// ✋ line is something only the owner can do, with the exact command. A
// product also gets an ℹ line saying how far behind its base it is: a report,
// never a ✋.
//
// GitHub is reached through `gh api` (REST), not `gh repo`, `gh issue` or
// `gh auth status`: those are GraphQL or need a local login, and Claude Code
// cloud sessions refuse the one and have the other (#225). `gh secret list`
// is REST already and stays.
import { execFile, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, checkTarget, loadCatalogue, plan, writeEntries } from './assemble.mjs';
import { apply as applyLabels, loadManifest as loadLabelManifest } from './labels.mjs';
import { ROOT, apps, deployed, loadProject } from './project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STORY_TEMPLATE_PATH = join(HERE, '../.github/ISSUE_TEMPLATE/story.md');

/** The template's text without its GitHub front matter: what a filed issue's body is. */
export function storyTemplateBody(text = readFileSync(STORY_TEMPLATE_PATH, 'utf8')) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
}

// The remote name a clone of this base is given, push disabled, so a clone
// can still fetch upstream improvements without ever pushing to this base by
// accident. Literal, not "the base": this is the one place that name is the
// base's own, because it is what the clone's own git config calls it.
export const BASE_REMOTE = 'boris';

export const PREFLIGHT_NODE_MAJOR = 22;

const ADD_USAGE = 'add --starter <s> [--starter <s> ...]';
const CREATE_USAGE = 'create --name <n> --owner <o> [--starter <s> ...] [--deploy <provider>] [--dir <path>] [--public]';

/**
 * `npm` and `npx` are `.cmd` shims on Windows, which Node cannot start without
 * a shell (ENOENT, or EINVAL since CVE-2024-27980). Only those two, only on
 * win32: `gh`, `git` and `uv` are executables, and a shell on Linux would add
 * nothing. Every argument passed to them here is a fixed literal.
 */
export function needsShell(cmd, platform = process.platform) {
  return platform === 'win32' && (cmd === 'npm' || cmd === 'npx');
}

const SHELL_TOKEN = /^[A-Za-z0-9@._\/=:+-]+$/;

/**
 * The one command string a shell will run for `cmd args`. A shell interprets
 * spaces, quotes, `&`, `|`, `^`, `%`, `<`, `>` and more, so every argument must
 * be a plain token; anything else is refused at runtime, whichever variable it
 * came through. Used only where needsShell is true.
 */
export function shellCommand(cmd, args) {
  for (const arg of args) {
    if (!SHELL_TOKEN.test(String(arg))) {
      throw new Error(`refusing to run ${cmd} through a shell with argument ${JSON.stringify(arg)}: only plain tokens (${SHELL_TOKEN}) are allowed`);
    }
  }
  return [cmd, ...args].join(' ');
}

/**
 * Runs `cmd args` and resolves to its exit status, stdout and stderr. Never
 * rejects, except for a refused shell argument. Through a shell (win32 npm/npx)
 * it passes one command string and no args array, which Node's DEP0190 asks for.
 */
export function exec(cmd, args, { platform = process.platform, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
    const done = (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    };
    if (needsShell(cmd, platform)) execFileImpl(shellCommand(cmd, args), { ...options, shell: true }, done);
    else execFileImpl(cmd, args, { ...options, shell: false }, done);
  });
}

/** `spawnSync` with inherited-stdio options; npm/npx on Windows as one guarded command string. */
export function spawnTool(cmd, args, options = {}, { platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (needsShell(cmd, platform)) return spawnImpl(shellCommand(cmd, args), { ...options, shell: true });
  return spawnImpl(cmd, args, { ...options, shell: false });
}

function reason({ stdout, stderr }) {
  return (stderr?.trim() || stdout?.trim() || '').trim();
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Bare values and no flags at all is what a stripped `--` leaves: on Windows,
 * `npm run setup -- create --name a --owner b` reaches us as
 * `create a b` because npm consumed the flags as its own config (#276).
 * Say so, instead of "unknown flag".
 */
function refuseStrippedFlags(command, argv) {
  if (argv.length === 0 || argv.some((a) => a.startsWith('--'))) return;
  throw new Error(
    `usage: ${command} got values (${argv.join(' ')}) but no flags. ` +
      'npm drops the flags after `npm run setup --` on Windows PowerShell. ' +
      `Run it without npm: node scripts/setup.mjs ${command} ` +
      (command === 'create'
        ? '--name <n> --owner <o> [--starter <s> ...]'
        : command === 'add'
          ? '--starter <s> [--starter <s> ...]'
          : '[--skip-verify] [--dry-run] [--repo owner/name] [--with <name>,...]'),
  );
}

/**
 * `create`'s flags, defaulting `--dir` to `../<name>` and `--public` to false.
 * `--starter` may repeat. Whether the starters and the provider exist is the
 * catalogue's to say, so `create` checks that, not this.
 */
export function parseCreateArgs(argv) {
  refuseStrippedFlags('create', argv);
  const opts = { public: false, starters: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--public') {
      opts.public = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--name' || flag === '--owner' || flag === '--dir' || flag === '--starter' || flag === '--deploy') {
      if (value === undefined || value.startsWith('--')) throw new Error(`usage: ${flag} needs a value`);
      if (flag === '--starter') opts.starters.push(value);
      else opts[flag.slice(2)] = value;
      i++;
      continue;
    }
    throw new Error(`usage: ${CREATE_USAGE}: unknown flag "${flag}"`);
  }
  if (!opts.name) throw new Error('usage: --name <n> is required');
  if (!opts.owner) throw new Error('usage: --owner <o> is required');
  checkOwner(opts.owner);
  if (!opts.dir) opts.dir = `../${opts.name}`;
  return opts;
}

/** `add`'s flags: one or more `--starter`. Whether each exists is the catalogue's to say, so `add` checks that. */
export function parseAddArgs(argv) {
  refuseStrippedFlags('add', argv);
  const opts = { starters: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--starter') throw new Error(`usage: ${ADD_USAGE}: unknown flag "${flag}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('usage: --starter needs a value');
    opts.starters.push(value);
    i++;
  }
  if (opts.starters.length === 0) throw new Error(`usage: ${ADD_USAGE}: at least one --starter is required`);
  return opts;
}

/** An Error `main` turns into exit status 2 (a usage mistake caught before anything is done). */
function usageError(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

/** `check`'s flags. Every one is optional. `--with` names optional integrations to file issues for. */
export function parseCheckArgs(argv) {
  refuseStrippedFlags('check', argv);
  const opts = { skipVerify: false, dryRun: false, with: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--with') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw usageError('usage: --with needs a value');
      const names = value.split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length === 0) throw usageError('usage: --with needs a value');
      const valid = OPTIONAL_NAMES;
      const unknown = names.filter((n) => !valid.includes(n));
      if (unknown.length > 0) {
        throw usageError(`usage: --with takes a comma-separated list of: ${valid.join(', ')}; got ${unknown.map((n) => JSON.stringify(n)).join(', ')}`);
      }
      for (const n of names) if (!opts.with.includes(n)) opts.with.push(n);
      i++;
    } else if (flag === '--skip-verify') {
      opts.skipVerify = true;
    } else if (flag === '--dry-run') {
      opts.dryRun = true;
    } else if (flag === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('usage: --repo needs a value');
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
        throw new Error(`usage: --repo must look like owner/name (letters, digits, "_", "." and "-" only), got ${JSON.stringify(value)}`);
      }
      opts.repo = value;
      i++;
    } else {
      throw new Error(`usage: check [--skip-verify] [--dry-run] [--repo owner/name] [--with <name>,...]: unknown flag "${flag}"`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Preflight (create, step 1)
// ---------------------------------------------------------------------------

/**
 * Every tool `create` needs, each `{ name, ok, detail }`. `run(cmd, args)` is
 * injected so this never shells out in a test; `nodeVersion` likewise, so a
 * test can assert both sides of the >= 22 check without the test runner's
 * own Node version deciding the answer.
 */
export async function preflight({ run = exec, nodeVersion = process.version, python = true } = {}) {
  const results = [];

  // `gh api user`, not `gh auth status`: a cloud session authenticates through
  // its proxy, which `gh auth status` reports as an invalid token while every
  // call works. A REST call that succeeds is the proof that matters.
  const ghAuth = await run('gh', ['api', 'user', '--jq', '.login']);
  results.push({
    name: 'gh api user',
    ok: ghAuth.status === 0,
    detail: ghAuth.status === 0 ? `authenticated as ${ghAuth.stdout.trim()}` : reason(ghAuth),
  });

  const git = await run('git', ['--version']);
  results.push({ name: 'git', ok: git.status === 0, detail: git.status === 0 ? git.stdout.trim() : reason(git) });

  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  const nodeOk = Number.isFinite(major) && major >= PREFLIGHT_NODE_MAJOR;
  results.push({ name: `node >= ${PREFLIGHT_NODE_MAJOR}`, ok: nodeOk, detail: nodeVersion });

  // uv installs a Python app's dependencies; a product with none does not need it.
  if (python) {
    const uv = await run('uv', ['--version']);
    results.push({ name: 'uv', ok: uv.status === 0, detail: uv.status === 0 ? uv.stdout.trim() : reason(uv) });
  }

  const npm11 = await run('npx', ['npm@11', '--version']);
  results.push({ name: 'npx npm@11', ok: npm11.status === 0, detail: npm11.status === 0 ? npm11.stdout.trim() : reason(npm11) });

  return results;
}

/** The preflight checks that failed, named for a report. */
export function missingPreflight(results) {
  return results.filter((r) => !r.ok);
}

// ---------------------------------------------------------------------------
// check: the list, and what it means for the exit code
// ---------------------------------------------------------------------------

// ℹ is a report: it changes nothing and asks nothing of the owner, so it never
// counts toward the exit code.
export const MARK = { done: '✔', fixed: '✚', owner: '✋', info: 'ℹ' };

/** `results` (each `{ mark, text }`) rendered as the printed lines, and the
 * exit code: 0 iff no ✋ remains. */
export function renderCheck(results) {
  return {
    lines: results.map((r) => `${r.mark} ${r.text}`),
    exitCode: results.some((r) => r.mark === MARK.owner) ? 1 : 0,
  };
}

/** Whether `develop` should get branch protection now, or wait on discipline:
 * public repositories can have it; a private one on the free plan cannot
 * (CLAUDE.md, "No paid tiers" — rulesets and classic branch protection both
 * return 403 there). */
export function branchProtectionDecision({ isPrivate }) {
  if (!isPrivate) {
    return { mark: MARK.fixed, text: 'branch protection: enabling classic protection on develop requiring the verify check' };
  }
  return {
    mark: MARK.done,
    text: 'branch protection: private, free-plan repository — enforced by discipline (docs/sops.md SOP 1), not mechanically',
  };
}

/** An owner issue body in the sections of .github/ISSUE_TEMPLATE/story.md.
 * Every owner issue is `human`, so Details to complete holds the instructions. */
function ownerBody({ story, scenarios, details }) {
  const blocks = scenarios
    .map(([name, given, when, then]) => `**Scenario: ${name}**\n- **Given** ${given}\n- **When** ${when}\n- **Then** ${then}`)
    .join('\n\n');
  return (
    '## Persona\n\nOwner of this repository.\n\n' +
    `## Story\n\n${story}\n\n` +
    `## Acceptance criteria\n\n${blocks}\n\n` +
    `## Details to complete\n\n${details}\n\n` +
    '## Tech notes\n\nNone. This is a task for the owner, not for an agent.\n\n' +
    '## Testing notes\n\nThe checks under Acceptance criteria are the proof.\n\n' +
    '## References\n\n- `docs/sops.md` SOP 2\n'
  );
}

/** An agent issue body in the same sections. Nobody is asked to do anything:
 * an agent picks it up, so Details to complete is written for one. */
function agentBody({ story, scenarios, details, tech }) {
  const blocks = scenarios
    .map(([name, given, when, then]) => `**Scenario: ${name}**\n- **Given** ${given}\n- **When** ${when}\n- **Then** ${then}`)
    .join('\n\n');
  return (
    '## Persona\n\nAn agent working this repository\'s backlog.\n\n' +
    `## Story\n\n${story}\n\n` +
    `## Acceptance criteria\n\n${blocks}\n\n` +
    `## Details to complete\n\n${details}\n\n` +
    `## Tech notes\n\n${tech}\n\n` +
    '## Testing notes\n\nThe checks under Acceptance criteria are the proof.\n\n' +
    '## References\n\n- `docs/sops.md` SOP 2\n'
  );
}

// The issues `check` files, each matched by exact title so a re-run never
// duplicates one. `owner: true` ones need a login, money or a credential: they
// carry `human` + `do not automate` (docs/sops.md SOP 2), are assigned to the
// owner, and an `optional` one is filed only when asked for with `--with
// <name>`. `owner: false` ones are agent work: their rank label only, unassigned.
export const OWNER_ISSUES = [
  {
    title: 'Add CLAUDE_CODE_OAUTH_TOKEN',
    rank: 'critical',
    owner: true,
    secret: 'CLAUDE_CODE_OAUTH_TOKEN', // not filed while this repository secret is set
    body: (repo) =>
      ownerBody({
        story:
          'As the **owner**, I want the `CLAUDE_CODE_OAUTH_TOKEN` secret set on the repository, so that the code and security reviews post real verdicts on every pull request.',
        scenarios: [
          ['the secret is set', 'the token is saved as a repository secret', 'the next pull request is opened', 'both reviews post a verdict on it'],
          ['the secret is missing', 'the secret is absent', 'a pull request that is not Dependabot\'s is opened', 'the review job logs the warning "Code review has no credential" and its assertion step fails'],
        ],
        details:
          '1. In a terminal where you are logged in to Claude, generate a token. The command prints it; copy it from the terminal yourself.\n\n' +
          '```bash\nclaude setup-token\n```\n\n' +
          '2. Save it as the repository secret. The command prompts for the value: paste the token there yourself. It never goes in the repository, an issue or a chat.\n\n' +
          `\`\`\`bash\ngh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}\n\`\`\`\n\n` +
          '3. Check the name is listed (values are never shown).\n\n' +
          `\`\`\`bash\ngh secret list -R ${repo}\n\`\`\`\n\n` +
          '4. Comment on this issue "done" and close it. Do this before the first pull request.',
      }),
  },
  {
    title: 'Optional: Telegram notifications',
    rank: 'medium',
    owner: true,
    optional: 'telegram',
    body: (repo) =>
      ownerBody({
        story:
          'As the **owner**, I want a Telegram message when a pull request merges, so that I see merges as they happen. Optional: skip it and merges are silent.',
        scenarios: [
          ['notifications are on', 'both secrets are set', 'a pull request merges', 'a Telegram message about that merge arrives in the chat'],
          ['notifications are skipped', 'neither secret is set', 'a pull request merges', 'the job\'s log says "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set on this repository."'],
        ],
        details:
          "1. These two steps happen in Telegram and are described in Telegram's own documentation, which this repository does not copy: https://core.telegram.org/bots. You need to come back with two values: the bot token and the chat id. The merge workflow (`.github/workflows/telegram-notify.yml`) posts to `https://api.telegram.org/bot<token>/sendMessage` with that `chat_id`.\n" +
          '2. Save the bot token. The command prompts for the value: paste it yourself. It never goes in the repository, an issue or a chat.\n\n' +
          `\`\`\`bash\ngh secret set TELEGRAM_BOT_TOKEN -R ${repo}\n\`\`\`\n\n` +
          '3. Save the chat id the same way.\n\n' +
          `\`\`\`bash\ngh secret set TELEGRAM_CHAT_ID -R ${repo}\n\`\`\`\n\n` +
          '4. Comment on this issue "done" (or "skipped") and close it.',
      }),
  },
  {
    title: 'Optional: Grafana CI telemetry',
    rank: 'medium',
    owner: true,
    optional: 'grafana',
    body: (repo) =>
      ownerBody({
        story:
          'As the **owner**, I want Claude Code CI usage sent to Grafana Cloud (`telemetry/README.md`), so that I can see what CI spends. Optional: skip it and CI telemetry goes nowhere; local sessions are unaffected.',
        scenarios: [
          ['telemetry is on', 'both secrets are set', 'a CI job that runs Claude Code finishes', 'its usage appears in Grafana Cloud'],
          ['telemetry is skipped', 'neither secret is set', 'a CI job finishes', 'both workflows run with telemetry off'],
        ],
        details:
          '1. In the Grafana Cloud Portal, open your stack, then the **OpenTelemetry** tile, then Configure. Generate a token; it prints the `OTEL_*` variables ready-made.\n' +
          '2. Install the **Claude Code** integration from Connections.\n' +
          '3. Save the endpoint (the `OTEL_EXPORTER_OTLP_ENDPOINT` value, ending `/otlp`). The command prompts for the value: paste it yourself.\n\n' +
          `\`\`\`bash\ngh secret set GRAFANA_CLOUD_OTLP_ENDPOINT -R ${repo}\n\`\`\`\n\n` +
          '4. Save the whole `OTEL_EXPORTER_OTLP_HEADERS` value, `Authorization=Basic <base64>`, at the prompt. The token never goes in the repository, an issue or a chat.\n\n' +
          `\`\`\`bash\ngh secret set GRAFANA_CLOUD_OTLP_AUTH -R ${repo}\n\`\`\`\n\n` +
          '5. Comment on this issue "done". The next CI run\'s review job log shows telemetry enabled, as `telemetry/README.md` ("Checking it actually arrives") describes. Comment "skipped" instead to leave it off.',
      }),
  },
  {
    title: "Merge Dependabot's first PR",
    rank: 'high',
    owner: false,
    body: (repo) =>
      agentBody({
        story:
          "As an **agent**, I want Dependabot's first pull request reviewed and merged, so that the dependency-update loop is proven to work end to end, not just configured.",
        scenarios: [
          ['the first update merges', "Dependabot's pull request has a green `verify`", 'the agent merges it', 'the dependency version on `develop` is the bumped one'],
          ['there is no pull request yet', 'there is no open Dependabot pull request', 'the agent lists the open pull requests by Dependabot', 'the list is empty, the agent comments "nothing to merge yet" once, and the issue is closed'],
          ['the pull request changes more than a version bump', "the diff of Dependabot's pull request touches a file besides the manifest and lockfile, or adds or changes an install script", 'the agent reads the diff', 'the agent comments the finding once and the issue is handed to the owner with the `human` label'],
        ],
        details:
          '1. List the open pull requests Dependabot has made.\n\n' +
          `\`\`\`bash\ngh api --paginate "repos/${repo}/pulls?state=open" --jq '.[] | select(.user.login == "dependabot[bot]") | [.number, .title] | @tsv'\n\`\`\`\n\n` +
          '2. If the list is empty, comment "nothing to merge yet" on this issue and close it as completed. Stop here.\n' +
          '3. Open the first one and read the changelog link in its body. Read its diff: it may change only the dependency manifest and its lockfile, and may add or change no install script (`preinstall`, `install`, `postinstall`, `prepare`). If it changes anything else, comment what you found, add the labels `human` and `do not automate` with the REST add-labels endpoint, and stop: the owner decides.\n' +
          '4. Wait for the `verify` check to be green. If it is red, comment that, add the same two labels, and stop.\n' +
          '5. Merge it into `develop` with the GitHub MCP tool `merge_pull_request`.\n' +
          '6. Comment on this issue with the pull request number, then close it.',
        tech: 'Merge with `merge_pull_request` (REST); `gh pr merge` is GraphQL, which cloud sessions refuse.',
      }),
  },
  {
    title: 'Rewrite README and CLAUDE.md around the product',
    rank: 'high',
    owner: false,
    body: (repo) =>
      agentBody({
        story:
          `As an **agent**, I want the README and CLAUDE.md of ${repo} to describe the product, so that the intro and the Layout match the application that is really here.`,
        scenarios: [
          ['the files describe the product', 'the application exists', 'a reader opens README.md and CLAUDE.md', 'the intro says what the product is for and the Layout lists its real directories'],
          ['the stub is gone', 'the rewrite is merged', 'the agent searches both files for the stub paragraph', 'the search output is empty'],
        ],
        details:
          '1. Read `project.json` and each `apps/*/CLAUDE.md` to learn what the product is and what directories it has.\n' +
          '2. Rewrite the intro and the Layout table of `README.md`, and the unshared sections of `CLAUDE.md` (the stub paragraph at the top and the Layout table), from what you read. Keep the shared rules block as it is: it is synced, and a shared file never names the repository it sits in.\n' +
          '3. Check the stub is gone.\n\n' +
          '```bash\ngrep -n "Replace this paragraph" CLAUDE.md README.md\n```\n\n' +
          '4. Open a pull request against `develop` and drive it to merged.',
        tech: 'Edit only `README.md` and the unshared sections of `CLAUDE.md`.',
      }),
  },
];

/** Which of OWNER_ISSUES don't already exist — open or closed, so a person
 * closing one by hand doesn't get it recreated — by exact title. An issue
 * that asks for a secret is also skipped while that secret is set. */
export function missingOwnerIssues(existingTitles, { secretNames = new Set(), withOptional = [] } = {}) {
  const have = new Set(existingTitles);
  const asked = new Set(withOptional);
  return OWNER_ISSUES.filter(
    (issue) =>
      !have.has(issue.title) &&
      !(issue.secret && secretNames.has(issue.secret)) &&
      (!issue.optional || asked.has(issue.optional)),
  );
}

/** The optional integrations `--with` may name. */
export const OPTIONAL_NAMES = OWNER_ISSUES.filter((i) => i.optional).map((i) => i.optional);

export const TEMPLATE_ISSUE_TITLE = 'Template: User story';

/** Whether an open issue already carries the `template` label — if one does,
 * creating another would be the duplicate `check` promises never to make. */
export function needsTemplateIssue(openIssues) {
  return !openIssues.some((issue) => (issue.labels ?? []).includes('template'));
}

// ---------------------------------------------------------------------------
// check: orchestration
// ---------------------------------------------------------------------------

/**
 * The `owner/name` an `origin` remote URL points at (scp-like, ssh or https
 * forms, with or without `.git`), or null. A product has two remotes (origin
 * and the fetch-only base), so gh's own {owner}/{repo} placeholders prompt
 * for a choice, and cannot prompt at all in Git Bash/MinTTY.
 */
export function parseGithubRepo(url) {
  const m = /^(?:[\w.+-]+@github\.com:|(?:ssh|https?|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `repo` if given, else the repository `origin` points at; throws when neither yields one. */
async function resolveRepo(run, root, repo) {
  if (repo) return repo;
  const origin = await run('git', ['-C', root, 'remote', 'get-url', 'origin']);
  const parsed = origin.status === 0 ? parseGithubRepo(origin.stdout) : null;
  if (!parsed) {
    const seen = origin.status === 0 ? JSON.stringify(origin.stdout.trim()) : `unreadable (${reason(origin)})`;
    throw new Error(`check: cannot tell which repository to check: origin is ${seen}, not a github.com URL. Pass --repo <owner>/<name>.`);
  }
  return parsed;
}

/** The REST path of `repo` (`owner/name`), or gh's own `{owner}/{repo}` placeholders (the cwd's remote). */
function repoRoute(repo) {
  return `repos/${repo ?? '{owner}/{repo}'}`;
}

/** The repository's settings `check` reads, from `GET /repos/{owner}/{repo}`. */
async function repoView(run, repo) {
  const result = await run('gh', ['api', repoRoute(repo)]);
  if (result.status !== 0) throw new Error(`gh api ${repoRoute(repo)} failed: ${reason(result)}`);
  const body = JSON.parse(result.stdout);
  return { isPrivate: body.private, deleteBranchOnMerge: body.delete_branch_on_merge, url: body.html_url };
}

/** Items per REST page; GitHub's maximum. */
const PAGE_SIZE = 100;

/** Pages of issues read before failing (SOP 1): 500 issues, matching the old `--limit 500`. */
export const MAX_ISSUE_PAGES = 5;

/**
 * Every issue of `repo`, in `state`, from REST's issues listing (which also
 * lists pull requests; they are dropped). Fails rather than returning a
 * partial list when it runs out of pages: the callers decide whether to file
 * something from what is *not* in it.
 */
async function listIssues(run, repo, state) {
  const issues = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const result = await run('gh', ['api', `${repoRoute(repo)}/issues?state=${state}&per_page=${PAGE_SIZE}&page=${page}`]);
    if (result.status !== 0) throw new Error(`gh api issues failed: ${reason(result)}`);
    const batch = JSON.parse(result.stdout);
    for (const item of batch) {
      if (!item.pull_request) {
        issues.push({ title: item.title, labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)) });
      }
    }
    if (batch.length < PAGE_SIZE) return issues;
  }
  throw new Error(`gh api issues returned ${MAX_ISSUE_PAGES * PAGE_SIZE} items and more pages remain; raise MAX_ISSUE_PAGES`);
}

/** The `gh api` arguments that file an issue: labels and assignees as arrays, which `gh issue create` would take as flags. */
function createIssueArgs(repo, { title, body, labels, assignee }) {
  return [
    'api',
    `${repoRoute(repo)}/issues`,
    '-X',
    'POST',
    '-f',
    `title=${title}`,
    '-f',
    `body=${body}`,
    ...labels.flatMap((l) => ['-f', `labels[]=${l}`]),
    ...(assignee ? ['-f', `assignees[]=${assignee}`] : []),
  ];
}

async function ghJson(run, args) {
  const result = await run('gh', args);
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${reason(result)}`);
  return JSON.parse(result.stdout);
}

/** `text`, capped to `maxLen` characters from the end — the failure is in the
 * last lines of a test run, not the first — with a note that it was cut. */
function trimOutput(text, maxLen = 3000) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `… (truncated)\n${trimmed.slice(-maxLen)}`;
}

/**
 * Runs the real `scripts/test/identity.test.ts`, rather than re-deriving a
 * second copy of what it allows: a duplicate list is exactly how the two
 * would quietly drift apart and start disagreeing with each other, which is
 * what the first live run of this check actually did (docs/sops.md SOP 3).
 */
function runIdentityCensus() {
  try {
    // Through a shell on purpose, like verify-apps.mjs's own npm/uv
    // invocations: npx is a .cmd shim on Windows.
    const output = execSync('npx vitest run --root scripts/test identity.test.ts', { cwd: ROOT, encoding: 'utf8' });
    return { ok: true, output };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message;
    return { ok: false, output };
  }
}

/** A SHA as a short, readable id. */
const short = (sha) => sha.slice(0, 7);

/**
 * How far behind its base a product is: fetches the base's `develop` through
 * the fetch-only remote `create` set up, and counts the commits `commit` (the
 * product's `engine.commit`) lacks. Always an ℹ line, never a ✋: being behind
 * is a fact to act on when convenient, and a fetch that fails or a commit the
 * base's history does not contain is reported as exactly that, not guessed at.
 */
export async function engineDrift({ run, root, commit }) {
  const git = (args) => run('git', ['-C', root, ...args]);
  const fetched = await git(['fetch', '--no-tags', BASE_REMOTE, 'develop']);
  if (fetched.status !== 0) {
    return {
      mark: MARK.info,
      text: `how far behind ${BASE_REMOTE} cannot be measured: git fetch ${BASE_REMOTE} develop failed (${reason(fetched)}) — the fetch-only ${BASE_REMOTE} remote may be missing from this clone`,
    };
  }
  const known = await git(['merge-base', '--is-ancestor', commit, 'FETCH_HEAD']);
  // Exit 1 is git's answer "not an ancestor"; anything else (128 for an
  // unknown object, say) is git failing to answer, and says so.
  if (known.status === 1) {
    return {
      mark: MARK.info,
      text: `engine.commit ${short(commit)} is not in ${BASE_REMOTE}'s develop history (unpushed, or rewritten), so how far behind cannot be counted`,
    };
  }
  if (known.status !== 0) {
    return { mark: MARK.info, text: `how far behind ${BASE_REMOTE} cannot be checked: git merge-base failed (${reason(known)})` };
  }
  const counted = await git(['rev-list', '--count', `${commit}..FETCH_HEAD`]);
  const behind = Number(counted.stdout.trim());
  if (counted.status !== 0 || !/^\d+$/.test(counted.stdout.trim())) {
    return { mark: MARK.info, text: `how far behind ${BASE_REMOTE} cannot be counted: git rev-list failed (${reason(counted)})` };
  }
  if (behind === 0) return { mark: MARK.info, text: `up to date with ${BASE_REMOTE} (engine.commit ${short(commit)})` };
  return {
    mark: MARK.info,
    text: `behind ${BASE_REMOTE} by ${behind} commit${behind === 1 ? '' : 's'} (engine.commit ${short(commit)}); the sync-ai-layer skill brings them in and moves engine.commit`,
  };
}

/**
 * Runs `check` for real: every line `node scripts/setup.mjs check` prints, and the
 * exit code. `run` defaults to the real `gh`/`git`; `fetchUrl` to the real
 * `fetch`; `runVerify` and `runIdentityTest` to actually spawning `npm run
 * verify` and the identity test. Each is injectable so a test can drive this
 * without the network — though this repository's own test list only asks
 * for the pure pieces above; this function is exercised for real, with
 * `--dry-run`, and its output goes in the pull request body (docs/sops.md
 * SOP 3: a control is verified where it runs, not only in a unit test).
 */
export async function runCheck({
  repo,
  root = ROOT,
  dryRun = false,
  skipVerify = false,
  withOptional = [],
  run = exec,
  fetchUrl = fetch,
  runVerify,
  runIdentityTest = runIdentityCensus,
} = {}) {
  repo = await resolveRepo(run, root, repo);
  const results = [];
  const repoArg = (args) => (repo ? [...args, '--repo', repo] : args);

  // Labels
  const manifest = loadLabelManifest();
  const labelActions = await applyLabels({ run: (args) => run('gh', args), manifest, repo, dryRun, log: () => {} });
  results.push(
    labelActions.length === 0
      ? { mark: MARK.done, text: 'labels match labels.json' }
      : { mark: MARK.fixed, text: `labels: ${labelActions.map((a) => `${a.action} ${a.name}`).join(', ')}` },
  );

  // delete_branch_on_merge, and the repository's visibility for the branch
  // protection decision below.
  const view = await repoView(run, repo);
  if (view.deleteBranchOnMerge) {
    results.push({ mark: MARK.done, text: 'delete_branch_on_merge is already on' });
  } else if (dryRun) {
    results.push({ mark: MARK.owner, text: 'would enable delete_branch_on_merge: PATCH the repository with delete_branch_on_merge=true' });
  } else {
    const edit = await run('gh', ['api', repoRoute(repo), '-X', 'PATCH', '-F', 'delete_branch_on_merge=true']);
    if (edit.status !== 0) throw new Error(`enabling delete_branch_on_merge failed: ${reason(edit)}`);
    results.push({ mark: MARK.fixed, text: 'enabled delete_branch_on_merge' });
  }

  // Branch protection
  const protection = branchProtectionDecision({ isPrivate: view.isPrivate });
  if (protection.mark === MARK.fixed && dryRun) {
    results.push({ mark: MARK.owner, text: `would set branch protection: ${protection.text}` });
  } else if (protection.mark === MARK.fixed) {
    // `gh api` takes no --repo flag of its own: the repository comes from
    // the path itself, so `repoRoute` splices a given `repo` into it, and
    // gh's own {owner}/{repo} placeholders (resolved from the cwd's git
    // remote) cover the default.
    const branchArgs = [
      'api',
      `${repoRoute(repo)}/branches/develop/protection`,
      '-X',
      'PUT',
      '-f',
      'required_status_checks[strict]=true',
      '-f',
      'required_status_checks[contexts][]=verify',
      '-F',
      'enforce_admins=true',
      '-F',
      'required_pull_request_reviews=null',
      '-F',
      'restrictions=null',
    ];
    const protect = await run('gh', branchArgs);
    results.push(
      protect.status === 0
        ? protection
        : { mark: MARK.owner, text: `branch protection: gh could not set it (${reason(protect)}) — set it by hand on develop, requiring "verify"` },
    );
  } else {
    results.push(protection);
  }

  // CLAUDE_CODE_OAUTH_TOKEN, by name only
  const secrets = await ghJson(run, repoArg(['secret', 'list', '--json', 'name']));
  const secretNames = new Set(secrets.map((s) => s.name));
  results.push(
    secretNames.has('CLAUDE_CODE_OAUTH_TOKEN')
      ? { mark: MARK.done, text: 'CLAUDE_CODE_OAUTH_TOKEN is set' }
      : {
          mark: MARK.owner,
          text: `CLAUDE_CODE_OAUTH_TOKEN is missing — run \`claude setup-token\`, then \`gh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}\` — before the first PR, or every review errors`,
        },
  );

  // Owner issues, deduplicated by title
  const allIssues = await listIssues(run, repo, 'all');
  const missing = missingOwnerIssues(
    allIssues.map((i) => i.title),
    { secretNames, withOptional },
  );
  // An optional integration nobody asked for is not filed; say how to ask.
  const existingTitles = new Set(allIssues.map((i) => i.title));
  for (const issue of OWNER_ISSUES) {
    if (issue.optional && !withOptional.includes(issue.optional) && !existingTitles.has(issue.title)) {
      results.push({ mark: MARK.info, text: `${issue.optional}: optional, no issue filed. To file one: node scripts/setup.mjs check --with ${issue.optional}` });
    }
  }
  let assignee; // the authenticated login, looked up once and only if an issue is actually filed
  for (const issue of missing) {
    const label = issue.owner ? [issue.rank, 'human', 'do not automate'] : [issue.rank];
    const kind = issue.owner ? 'owner' : 'agent';
    if (dryRun) {
      results.push({ mark: issue.owner ? MARK.owner : MARK.info, text: `would file ${kind} issue "${issue.title}"` });
      continue;
    }
    if (issue.owner && assignee === undefined) {
      // Owner issues must be assigned (SOP 2), so a failed lookup stops the run
      // rather than filing them unassigned and reporting them filed.
      const me = await run('gh', ['api', 'user', '--jq', '.login']);
      if (me.status !== 0 || !me.stdout.trim()) throw new Error(`gh api user failed: ${reason(me)}`);
      assignee = me.stdout.trim();
    }
    const created = await run('gh', createIssueArgs(repo, { title: issue.title, body: issue.body(repo), labels: label, assignee: issue.owner ? assignee : undefined }));
    results.push(
      created.status === 0
        ? { mark: MARK.fixed, text: `filed ${kind} issue "${issue.title}"` }
        : { mark: MARK.owner, text: `could not file "${issue.title}" (${reason(created)}) — file it by hand${issue.owner ? ', labelled human + do not automate' : ''}` },
    );
  }
  if (missing.length === 0) results.push({ mark: MARK.done, text: 'every issue already exists' });

  // Story template issue
  const openIssues = await listIssues(run, repo, 'open');
  if (!needsTemplateIssue(openIssues)) {
    results.push({ mark: MARK.done, text: 'a template issue is already open' });
  } else if (dryRun) {
    results.push({ mark: MARK.owner, text: `would file "${TEMPLATE_ISSUE_TITLE}" from ${STORY_TEMPLATE_PATH}` });
  } else {
    const body = storyTemplateBody();
    const created = await run('gh', createIssueArgs(repo, { title: TEMPLATE_ISSUE_TITLE, body, labels: ['template'] }));
    results.push(
      created.status === 0
        ? { mark: MARK.fixed, text: `filed "${TEMPLATE_ISSUE_TITLE}"` }
        : { mark: MARK.owner, text: `could not file "${TEMPLATE_ISSUE_TITLE}" (${reason(created)}) — copy it by hand from .github/ISSUE_TEMPLATE/story.md (without its front matter), labelled template` },
    );
  }

  // Identity census: the real test, not a second copy of what it allows.
  const census = await runIdentityTest();
  results.push(
    census.ok
      ? { mark: MARK.done, text: 'identity census: scripts/test/identity.test.ts passes' }
      : { mark: MARK.owner, text: `identity census: scripts/test/identity.test.ts failed —\n${trimOutput(census.output)}` },
  );

  // Deploy checks, one per app with a deploy block
  const project = loadProject(join(root, 'project.json'));
  const deployedApps = deployed(project);
  if (deployedApps.length === 0) {
    results.push({ mark: MARK.done, text: 'no app has a deploy block — nothing to check' });
  } else {
    for (const [name, app] of deployedApps) {
      let reachable = false;
      try {
        const response = await fetchUrl(app.deploy.url, { signal: AbortSignal.timeout(10_000) });
        const body = await response.text();
        reachable = response.status === 200 && !/sign.?in|authenticate|vercel\.com\/sso/i.test(body);
      } catch {
        reachable = false;
      }
      results.push(
        reachable
          ? { mark: MARK.done, text: `${name}: ${app.deploy.url} answers 200 with no login page` }
          : { mark: MARK.owner, text: `${name}: ${app.deploy.url} did not answer 200 with no login page — check deployment protection is off` },
      );
      const hasToken = secretNames.has('VERCEL_TOKEN');
      results.push(
        hasToken
          ? { mark: MARK.done, text: 'VERCEL_TOKEN is set' }
          : { mark: MARK.owner, text: 'VERCEL_TOKEN is missing — add a team-scoped token before the next deploy' },
      );
      const readmePath = join(root, 'README.md');
      const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
      const expiryRecorded = /VERCEL_TOKEN[^\n]*\d{4}-\d{2}-\d{2}/i.test(readme);
      results.push(
        expiryRecorded
          ? { mark: MARK.done, text: "VERCEL_TOKEN's expiry is recorded" }
          : { mark: MARK.owner, text: "VERCEL_TOKEN's expiry is not recorded — add it to README.md's secrets table" },
      );
    }
  }

  // How far behind its base this repository is. Only a product has an
  // engine.commit; the base itself is the engine and has nothing to measure.
  // `git fetch` writes to the clone (FETCH_HEAD), which --dry-run promises not to.
  if (project.engine && dryRun) {
    results.push({ mark: MARK.info, text: `drift check skipped under --dry-run: it runs git fetch ${BASE_REMOTE} develop, which writes to this clone` });
  } else if (project.engine) {
    results.push(await engineDrift({ run, root, commit: project.engine.commit }));
  }

  // npm run verify
  if (skipVerify) {
    results.push({ mark: MARK.done, text: 'npm run verify: skipped (--skip-verify)' });
  } else {
    const verify = runVerify ? runVerify() : spawnTool('npm', ['run', 'verify'], { stdio: 'inherit' }).status ?? 1;
    results.push(
      verify === 0
        ? { mark: MARK.done, text: 'npm run verify passes' }
        : { mark: MARK.owner, text: `npm run verify is red (exit ${verify}) — fix it before anything else` },
    );
  }

  const { lines, exitCode } = renderCheck(results);
  const footer = [
    '',
    'Next steps:',
    '- File the backlog: issues ranked critical/high/medium, with "Depends on #n" lines and acceptance criteria.',
    '- Ship one small pull request end to end, and confirm both reviews post real verdicts, not just green checks.',
    '- `npm run deploy:add -- vercel --app <app> ...` once an app should actually deploy.',
    '- Then the `work-backlog` skill picks up the rest.',
  ];
  return { lines: [...lines, ...footer], exitCode };
}

// ---------------------------------------------------------------------------
// create: orchestration
// ---------------------------------------------------------------------------

/**
 * Whether `target` is safe for `create` to clone into: either it doesn't
 * exist yet, or it exists with no branches. Fails closed: any non-zero
 * status or unparseable JSON from the emptiness check itself throws with
 * `gh`'s own stderr, rather than falling through to "assume empty". Proceeds
 * only on the positive answer, an empty branch listing — not "no commits
 * found", which a failed call can also look like.
 */
export async function ensureEmptyTarget({ run, target }) {
  const view = await run('gh', ['api', `repos/${target}`, '--jq', '.name']);
  if (view.status !== 0) {
    // Only a 404 means absent; a 403 from the proxy, a rate limit or a network
    // error says nothing about whether the repository exists.
    if (/HTTP 404/.test(`${view.stderr}\n${view.stdout}`)) return { exists: false }; // create() will create it
    throw new Error(`gh api repos/${target} failed: ${reason(view)}`);
  }

  const branches = await run('gh', ['api', `repos/${target}/branches?per_page=1`]);
  if (branches.status !== 0) {
    // GitHub answers some endpoints for a repository with no commits with
    // exactly this 409. Unverified against a real empty repository.
    const text = `${branches.stderr}\n${branches.stdout}`;
    if (/HTTP 409/.test(text) && /Git Repository is empty\./.test(text)) return { exists: true };
    throw new Error(`gh api repos/${target}/branches failed: ${reason(branches)}`);
  }
  let list;
  try {
    list = JSON.parse(branches.stdout);
  } catch {
    throw new Error(`gh api repos/${target}/branches returned unparseable JSON: ${branches.stdout}`);
  }
  if (!Array.isArray(list)) throw new Error(`gh api repos/${target}/branches returned something other than a list: ${branches.stdout}`);
  if (list.length > 0) throw new Error(`setup create: ${target} already exists and is not empty`);
  return { exists: true };
}

/**
 * Throws unless `owner` is a GitHub login or organisation name. It goes into
 * REST paths (`repos/<owner>/<name>`, `orgs/<owner>/repos`) and into the
 * product's origin URL, so anything with a `/`, `?`, `#` or `..` in it could
 * point a call somewhere else.
 */
export function checkOwner(owner) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new Error(`setup create: owner "${String(owner)}" is not a GitHub user or organisation name (letters, digits and "-", at most 39, starting with a letter or digit)`);
  }
}

/**
 * Throws, naming what catalogue.json offers, unless every one of `starters`
 * and `deploy` (when given) is in `catalogue`. Run before anything is read from
 * git or the network, so a mistyped name costs nothing.
 */
export function checkChoices({ catalogue, starters, deploy }) {
  const offered = (entries) => Object.keys(entries).join(', ');
  // No --starter is an engine-only product, so an empty list is not refused.
  for (const starter of starters) {
    if (!catalogue.starters[starter]) {
      throw new Error(`setup create: no starter named "${starter}" (catalogue.json offers: ${offered(catalogue.starters)})`);
    }
  }
  if (deploy !== undefined && !catalogue.providers[deploy]) {
    throw new Error(`setup create: no provider named "${deploy}" (catalogue.json offers: ${offered(catalogue.providers)})`);
  }
}

/**
 * `url` without a secret a remote URL may carry, so none lands in the product's
 * git config. For http(s) that is the whole `user[:password]@`, since the user
 * part can itself be a token. For any other `scheme://userinfo@host` (ssh
 * included) it is the `:password` only: the username (`git`) is what lets the
 * connection be made and is no secret. A URL with no userinfo, and scp-style
 * `git@host:path`, are returned as they are.
 */
export function withoutCredentials(url) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*)@/i.exec(url);
  if (!match) return url;
  const [whole, scheme, userinfo] = match;
  const user = /^https?$/i.test(scheme) ? '' : `${userinfo.split(':')[0]}@`;
  return `${scheme}://${user}${url.slice(whole.length)}`;
}

/**
 * `create`, run for real: assembles a product from the chosen starters
 * (scripts/assemble.mjs does the copying), gives it one commit of its own and
 * no base history, creates the GitHub repository over REST, and pushes. Never
 * run for real from a test, and never by an agent — the repository is the
 * owner's to create. `run`, `spawn`, `root` and `log` are injectable so a test
 * can drive every step, including the real assembly into a scratch directory.
 *
 * Everything that can be refused is refused before anything is created: the
 * choices, the name, the target directory, a dirty or history-less base
 * checkout, and a GitHub repository that already holds something. After that
 * the order is the safe one: build, lock, verify, commit, and only then create
 * the remote and push — so a failure up to and including `verify` leaves
 * nothing on GitHub, and a directory the owner can look at.
 *
 * `--deploy` deploys nothing: a Vercel project is the owner's to create. It
 * only checks the provider exists and prints the `deploy:add` command.
 *
 * Returns `check`'s exit code, from the *product's own copy* of this script,
 * run as a separate process with `cwd: opts.dir`. It must not call `runCheck`
 * in this process: this process's own `loadProject()`, the identity census,
 * and the README read would all inspect this checkout — the base — not the
 * new repository `check` is meant to grade.
 */
export async function create(opts, { run = exec, spawn = spawnTool, root = ROOT, log = console.log } = {}) {
  const catalogueFile = join(root, 'catalogue.json');
  if (!existsSync(catalogueFile)) {
    throw new Error(`setup create: ${root} has no catalogue.json; create runs from the base checkout, which says what a product can be made of`);
  }
  const catalogue = loadCatalogue(catalogueFile);
  checkOwner(opts.owner);
  checkChoices({ catalogue, starters: opts.starters, deploy: opts.deploy });
  const dir = resolve(opts.dir);
  // The same refusals assemble would make, taken now (a bad name, a missing
  // file, a target with anything in it) instead of after the network calls.
  // engineCommit is only known once git is asked, below; any full SHA stands in
  // for it, since an engine-only product's project.json needs one to validate.
  const planned = plan({ root, catalogue, name: opts.name, starters: opts.starters, engineCommit: '0'.repeat(40) });
  checkTarget(dir, root);

  const results = await preflight({ run, python: apps(planned.project, 'python').length > 0 });
  const missing = missingPreflight(results);
  if (missing.length > 0) {
    throw new Error(`setup create: missing ${missing.map((m) => m.name).join(', ')}`);
  }

  // The commit recorded as engine.commit must describe what was copied: only
  // tracked files are, so a modified or staged one makes HEAD a false record.
  const baseGit = (args) => run('git', ['-C', root, ...args]);
  const dirty = await baseGit(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.status !== 0) throw new Error(`git status failed in ${root}: ${reason(dirty)}`);
  if (dirty.stdout.trim()) {
    const paths = dirty.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3));
    const shown = paths.slice(0, 10).join(', ');
    const more = paths.length > 10 ? ` and ${paths.length - 10} more` : '';
    throw new Error(`setup create: ${root} has uncommitted changes to tracked files (${shown}${more}); commit or stash them, so engine.commit describes what is copied`);
  }
  const head = await baseGit(['rev-parse', 'HEAD']);
  const engineCommit = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(engineCommit)) throw new Error(`git rev-parse HEAD failed in ${root}: ${reason(head)}`);
  const upstream = await baseGit(['remote', 'get-url', 'origin']);
  if (upstream.status !== 0 || !upstream.stdout.trim()) {
    throw new Error(`setup create: ${root} has no origin remote, so the product would have nowhere to fetch ${BASE_REMOTE} from: ${reason(upstream)}`);
  }
  const baseUrl = withoutCredentials(upstream.stdout.trim());

  const target = `${opts.owner}/${opts.name}`;
  const { exists } = await ensureEmptyTarget({ run, target });

  const { project } = assemble({ root, catalogue, target: dir, name: opts.name, starters: opts.starters, engineCommit });
  log(`Assembled ${opts.starters.length ? opts.starters.join(' + ') : 'the engine alone (no starter)'} into ${dir}, recording engine.commit ${short(engineCommit)}`);

  const git = async (args) => {
    const result = await run('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${reason(result)}`);
    return result;
  };
  const step = (cmd, args, what) => {
    const result = spawn(cmd, args, { cwd: dir, stdio: 'inherit' });
    if ((result.status ?? 1) !== 0) throw new Error(`setup create: ${what} failed in ${dir}`);
  };

  // A product starts on the release scheme in docs/releases.md: `main` is
  // production, `develop` is staging and the default branch.
  const manifestFile = join(dir, 'project.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, productionBranch: 'main' }, null, 2)}\n`);
  await git(['init', '-b', 'develop']);
  // package-lock.json belongs to the node-react starter, so a product without
  // it has none and `npm ci` cannot run: lock it now (npm 11, CLAUDE.md
  // "Running it"), or the product's CI fails on its first push.
  if (!existsSync(join(dir, 'package-lock.json'))) step('npx', ['npm@11', 'install'], 'npm install (writing package-lock.json)');
  // The identity test reads the index, so the files are staged before verify.
  await git(['add', '-A']);
  step('npm', ['run', 'bootstrap'], 'npm run bootstrap');
  step('npm', ['run', 'verify'], 'npm run verify');
  // From here the product is built and verified, and a failure leaves a
  // directory and possibly an (empty) GitHub repository behind: say how to go on.
  try {
    await git(['add', '-A']);
    await git(['commit', '-m', `Start ${opts.name} from ${BASE_REMOTE}@${short(engineCommit)}`, '-m', `engine.commit ${engineCommit}`]);

    await git(['remote', 'add', BASE_REMOTE, baseUrl]);
    await git(['remote', 'set-url', '--push', BASE_REMOTE, 'DISABLED']);

    if (!exists) {
      // POST /user/repos for the authenticated account's own repository,
      // /orgs/{owner}/repos for an organisation's: `gh repo create` is GraphQL.
      const me = await run('gh', ['api', 'user', '--jq', '.login']);
      if (me.status !== 0) throw new Error(`gh api user failed: ${reason(me)}`);
      const route = me.stdout.trim().toLowerCase() === opts.owner.toLowerCase() ? 'user/repos' : `orgs/${opts.owner}/repos`;
      const created = await run('gh', ['api', route, '-X', 'POST', '-f', `name=${opts.name}`, '-F', `private=${opts.public ? 'false' : 'true'}`]);
      if (created.status !== 0) throw new Error(`creating ${target} failed: ${reason(created)}`);
    }
    await git(['remote', 'add', 'origin', `git@github.com:${target}.git`]);
    // main starts at the same commit as develop: nothing is released yet, and the first release PR carries everything.
    await git(['branch', 'main']);
    const push = await run('git', ['-C', dir, 'push', '-u', 'origin', 'develop', 'main']);
    if (push.status !== 0) throw new Error(`git push failed: ${reason(push)}`);
  } catch (error) {
    throw new Error(
      `${error.message}\n${dir} is built and verified. ${target} may exist but be empty; a rerun accepts an empty repository, ` +
        `but --dir must be empty or absent, so remove ${dir} first.`,
    );
  }

  // develop is the default branch (feature pull requests target it); the first
  // push may have made main the default. Outside the try above for the same
  // reason as the pin below: the push has succeeded, so "rerun" would be wrong.
  const defaulted = await run('gh', ['api', repoRoute(target), '-X', 'PATCH', '-f', 'default_branch=develop']);
  if (defaulted.status !== 0) {
    log(`\nWarning: setting develop as the default branch failed (${reason(defaulted)}); set develop as the default branch by hand: ${target} on GitHub, Settings, Branches.`);
  }

  // Two remotes (origin and the fetch-only base) make gh ask which repository
  // {owner}/{repo} means; pin it so every later gh command in the product works.
  // Outside the try above: the push has succeeded, so its "rerun" advice would be
  // wrong here. Not fatal either: the check below is given --repo regardless.
  // (spawned, not run: it reads the product's own remotes, so it needs cwd.)
  const pinned = spawn('gh', ['repo', 'set-default', target], { cwd: dir, stdio: 'inherit' });
  if ((pinned.status ?? 1) !== 0) {
    log(`\nWarning: \`gh repo set-default ${target}\` failed; run it by hand in ${dir}, or gh will ask which remote to use.`);
  }

  if (opts.deploy && Object.keys(project.apps).length === 0) {
    log(`\n${opts.deploy} is not set up: ${opts.name} has no apps, so there is nothing to deploy yet. \`deploy:add\` needs an app to deploy.`);
  } else if (opts.deploy) {
    log(`\n${opts.deploy} is not set up: the project is yours to create. In ${dir}, for each app to deploy:`);
    for (const app of Object.keys(project.apps)) log(`  npm run deploy:add -- ${opts.deploy} --app ${app}`);
  }

  const check = spawn('node', ['scripts/setup.mjs', 'check', '--repo', target], { cwd: dir, stdio: 'inherit' });
  return check.status ?? 1;
}


/**
 * Files `plan` derives, which `add` regenerates; project.json is merged instead.
 */
const REGENERATED = ['package.json', '.github/dependabot.yml', 'README.md', 'CLAUDE.md'];

/** The paths `git status` reports in `dir`, NUL-separated so none is quoted or escaped; empty when the tree is clean. */
async function dirtyPaths(run, dir) {
  const status = await run('git', ['-C', dir, 'status', '--porcelain', '-z']);
  if (status.status !== 0) throw new Error(`setup add: git status failed in ${dir}: ${reason(status)}`);
  const records = status.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    paths.push(records[i].slice(3));
    // A rename or copy is followed by its source path as a record of its own.
    if (/^[RC]/.test(records[i]) || /^.[RC]/.test(records[i])) i++;
  }
  return paths;
}

/**
 * Checks the base out at `commit` into a fresh directory, fetching it through
 * the product's fetch-only remote to the base, so the product's own git history
 * and object store are untouched. Returns the directory; the caller removes it.
 */
async function checkoutBase({ run, root, commit }) {
  const remote = await run('git', ['-C', root, 'remote', 'get-url', BASE_REMOTE]);
  if (remote.status !== 0 || !remote.stdout.trim()) {
    throw new Error(`setup add: ${root} has no ${BASE_REMOTE} remote to fetch the starters from: ${reason(remote)}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'setup-add-'));
  try {
    for (const args of [['init', '-q'], ['fetch', '-q', '--no-tags', '--depth', '1', remote.stdout.trim(), commit], ['checkout', '-q', '--detach', 'FETCH_HEAD']]) {
      const result = await run('git', ['-C', scratch, ...args]);
      if (result.status !== 0) {
        throw new Error(`setup add: git ${args[0]} of ${BASE_REMOTE} at engine.commit ${short(commit)} failed: ${reason(result)}`);
      }
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return scratch;
}

const DEP_KEYS = ['dependencies', 'devDependencies'];

/**
 * `current` (a product's root package.json, which may have been bumped) with the
 * `workspaces` and the scripts it lacks taken from `wanted`; nothing else changes.
 * Undefined when `current` is not a JSON object, so the caller leaves it alone.
 */
export function mergePackageJson(current, wanted) {
  let mine;
  try {
    mine = JSON.parse(current);
  } catch {
    return undefined;
  }
  if (mine === null || typeof mine !== 'object' || Array.isArray(mine)) return undefined;
  const theirs = JSON.parse(wanted);
  if (mine.workspaces === undefined && theirs.workspaces !== undefined) mine.workspaces = theirs.workspaces;
  const wantsScripts = Object.entries(theirs.scripts ?? {});
  // A scripts value that is not a plain object is the product's own business: leave the file.
  if (mine.scripts !== undefined && (mine.scripts === null || typeof mine.scripts !== 'object' || Array.isArray(mine.scripts))) return undefined;
  for (const [key, command] of wantsScripts) {
    mine.scripts = mine.scripts ?? {};
    if (!Object.hasOwn(mine.scripts, key)) mine.scripts[key] = command;
  }
  return `${JSON.stringify(mine, null, 2)}\n`;
}

/** A starter's package.json `text` with each dependency the root also declares set to the root's version. */
export function alignPins(text, rootText) {
  if (rootText === undefined) return text;
  let root;
  let manifest;
  try {
    root = JSON.parse(rootText);
    manifest = JSON.parse(text);
  } catch {
    return text;
  }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(root) || !isObject(manifest)) return text;
  const pins = { ...root.dependencies, ...root.devDependencies };
  let changed = false;
  for (const key of DEP_KEYS) {
    for (const name of Object.keys(manifest[key] ?? {})) {
      if (Object.hasOwn(pins, name) && manifest[key][name] !== pins[name]) {
        manifest[key][name] = pins[name];
        changed = true;
      }
    }
  }
  return changed ? `${JSON.stringify(manifest, null, 2)}\n` : text;
}

/**
 * `add`, run inside a product: copies each starter's files from the base at
 * the product's `engine.commit` and adds its app to project.json, then
 * regenerates the files assemble derives. Everything that can be refused is
 * refused before the first write, so a refusal leaves the product as it was.
 * A derived file the product has changed since it was generated is left alone
 * and named in the result (`kept`): `add` does not overwrite the product's own
 * words. Returns `{ added, kept }`. `run`, `root` and `log` are injectable.
 */
export async function add(opts, { run = exec, spawn = spawnTool, root = ROOT, log = console.log } = {}) {
  const projectFile = join(root, 'project.json');
  if (!existsSync(projectFile)) throw new Error(`setup add: ${root} has no project.json; add runs inside a product`);
  const current = JSON.parse(readFileSync(projectFile, 'utf8'));
  const commit = current.engine?.commit;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error('setup add: project.json has no engine.commit, so there is no base commit to take starters from; add runs inside a product made by `setup create`');
  }
  const repeated = opts.starters.find((key, i) => opts.starters.indexOf(key) !== i);
  if (repeated !== undefined) throw new Error(`setup add: starter "${repeated}" is given more than once`);
  const dirty = await dirtyPaths(run, root);
  if (dirty.length > 0) {
    const more = dirty.length > 10 ? ` and ${dirty.length - 10} more` : '';
    throw new Error(`setup add: ${root} has uncommitted changes (${dirty.slice(0, 10).join(', ')}${more}); commit or stash them first, so the change add makes is the only one to review`);
  }

  const base = await checkoutBase({ run, root, commit });
  try {
    const catalogue = loadCatalogue(join(base, 'catalogue.json'));
    for (const key of opts.starters) {
      if (!Object.hasOwn(catalogue.starters, key)) {
        throw new Error(`setup add: no starter named "${key}" (catalogue.json at ${short(commit)} offers: ${Object.keys(catalogue.starters).join(', ')})`);
      }
    }
    // Starters the product already has, by their app, so the layout lists them too.
    const have = Object.keys(catalogue.starters).filter((key) => Object.hasOwn(current.apps ?? {}, catalogue.starters[key].app));
    // One check for "the app is already there": declared in project.json, or its directory exists.
    const baseApps = loadProject(join(base, 'project.json')).apps;
    for (const key of opts.starters) {
      const { app } = catalogue.starters[key];
      const path = baseApps[app]?.path;
      if (have.includes(key) || (path && existsSync(join(root, ...path.split('/'))))) {
        throw new Error(`setup add: app "${app}" (starter "${key}") is already present in ${root}${path ? ` (${path})` : ''}; add never overwrites an app`);
      }
    }
    const name = current.name;
    const wanted = plan({ root: base, catalogue, name, starters: [...have, ...opts.starters], engineCommit: commit });
    const before = plan({ root: base, catalogue, name, starters: have, engineCommit: commit });

    const mine = new Set(opts.starters.map((key) => `starter ${key}`));
    // A lockfile the product already has stays its own; it is brought up to date below.
    const lockBefore = existsSync(join(root, 'package-lock.json'));
    const entries = wanted.entries.filter((entry) => mine.has(entry.source) && !(lockBefore && entry.to === 'package-lock.json'));
    const newApps = opts.starters.map((key) => catalogue.starters[key].app);
    const clash = entries.filter((entry) => existsSync(join(root, ...entry.to.split('/')))).map((entry) => entry.to);
    if (clash.length > 0) {
      throw new Error(`setup add: ${clash.slice(0, 10).join(', ')} already exist${clash.length === 1 ? 's' : ''} in ${root}; add never overwrites a file`);
    }

    // A derived file is regenerated only while it is still what was generated.
    const kept = [];
    const derived = [];
    for (const path of REGENERATED) {
      const next = wanted.entries.find((entry) => entry.to === path);
      const was = before.entries.find((entry) => entry.to === path);
      if (next.content === was.content) continue; // the new app changes nothing in it
      const onDisk = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined;
      if (onDisk === was.content) {
        derived.push(next);
        continue;
      }
      // A package.json the product (or Dependabot) has changed still needs the
      // new workspaces and scripts: merge them in, keep everything else as it is.
      const merged = path === 'package.json' && onDisk !== undefined ? mergePackageJson(onDisk, next.content) : undefined;
      if (merged === undefined) kept.push(path);
      else if (merged !== onDisk) derived.push({ ...next, content: merged });
    }
    // The root's pins win: a starter's shared tooling is aligned to them, so one copy installs.
    const rootEntry = derived.find((entry) => entry.to === 'package.json') ?? { content: existsSync(join(root, 'package.json')) ? readFileSync(join(root, 'package.json'), 'utf8') : undefined };
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].to === 'package.json' || !/(^|\/)package\.json$/.test(entries[i].to) || entries[i].from === undefined) continue;
      const text = readFileSync(join(base, ...entries[i].from.split('/')), 'utf8');
      const aligned = alignPins(text, rootEntry.content);
      if (aligned !== text) entries[i] = { to: entries[i].to, content: aligned, source: entries[i].source };
    }

    const merged = { ...current, apps: { ...current.apps } };
    for (const app of newApps) merged.apps[app] = wanted.project.apps[app];
    writeEntries(base, root, [...entries, ...derived, { to: 'project.json', content: `${JSON.stringify(merged, null, 2)}\n` }]);
    log(`Added ${opts.starters.join(' + ')} to ${root}, from ${BASE_REMOTE}@${short(commit)}: ${entries.length} files`);
    if (kept.length > 0) {
      log(`Left as they are, because they were changed since they were generated: ${kept.join(', ')}. Bring in what the new app needs by hand (the uv entry in dependabot.yml, the layout row in CLAUDE.md).`);
    }
    // `npm ci` fails when the lockfile lacks a workspace package.json now names.
    // A starter's own lockfile written just now is already right for it.
    const changed = derived.some((entry) => entry.to === 'package.json');
    if (changed && (lockBefore || !existsSync(join(root, 'package-lock.json')))) {
      log('package.json changed: running npx npm@11 install to bring package-lock.json up to date');
      const locked = spawn('npx', ['npm@11', 'install'], { cwd: root, stdio: 'inherit' });
      if ((locked.status ?? 1) !== 0) throw new Error(`setup add: npx npm@11 install failed in ${root}; the starters are written, run it yourself before npm run bootstrap`);
    } else if (kept.includes('package.json')) {
      const scripts = Object.keys(JSON.parse(wanted.entries.find((entry) => entry.to === 'package.json').content).scripts ?? {});
      log(`package.json was left as it is: add by hand the "workspaces" the new app needs (${newApps.map((app) => wanted.project.apps[app].path).join(', ')}) and these scripts if missing: ${scripts.join(', ')}; then run npx npm@11 install, or npm ci fails.`);
    }
    log('Next: npm run bootstrap, then npm run verify.');
    return { added: newApps, kept };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'create') {
    const opts = parseCreateArgs(rest);
    // Every step's output, including the product's own `check` at the end, is
    // streamed live via inherited stdio; create() adds only a few lines of its own.
    return await create(opts);
  }
  if (command === 'add') {
    await add(parseAddArgs(rest));
    return 0;
  }
  if (command === 'check') {
    let opts;
    try {
      opts = parseCheckArgs(rest);
    } catch (error) {
      if (error.exitCode === 2) {
        console.error(error.message);
        return 2;
      }
      throw error;
    }
    const { with: withOptional, ...checkOpts } = opts;
    const result = await runCheck({ ...checkOpts, withOptional });
    process.stdout.write(result.lines.join('\n') + '\n');
    return result.exitCode;
  }
  throw new Error(`usage: setup.mjs ${CREATE_USAGE} | ${ADD_USAGE} | check [--skip-verify] [--dry-run] [--repo owner/name] [--with <name>,...]`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
