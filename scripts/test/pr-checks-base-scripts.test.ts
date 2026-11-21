import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// #359, #371: `pr checks` holds `pull-requests: write` while it runs, so no
// script from the pull request's own checkout may execute in it. Both scripts
// run from `base-scripts/`, a separate checkout of the base commit.
//
// The check is an allowlist of what a step may run, not a search for one
// spelling of branch code: `node scripts/x.mjs` is one of a dozen ways to run
// the checkout, and a denylist loses to the next spelling. Anything not named
// here is rejected, naming the step. It covers: which commands run (after
// redirections are stripped), the exact form of `node`, the options `set`
// takes, which variables may be assigned or exported, writes to
// GITHUB_ENV/GITHUB_PATH, and env keys that change how commands resolve. It
// does not cover what an allowed command does with its own arguments (a `git`
// alias or hook in the checkout, say); that stays bounded by one writer
// (docs/data-governance.md).
const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/pr-checks.yml');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  shell?: unknown;
  'working-directory'?: unknown;
}
interface Defaults {
  run?: { shell?: unknown; 'working-directory'?: unknown };
}
interface Workflow {
  env?: Record<string, unknown>;
  defaults?: Defaults;
  jobs: { checks: { env?: Record<string, unknown>; defaults?: Defaults; steps: Step[] } };
}

const ALLOWED_COMMANDS = new Set(['gh', 'git', 'echo', 'cat', 'printf', 'base64', 'test', '[', 'set', 'export']);
const SHELL_KEYWORDS = new Set(['{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', '!']);
const BASE_SCRIPTS = 'base-scripts/scripts/';
const TOKEN = /GH_TOKEN|github\.token|secrets\./;
// Plain shell variables the real workflow sets or exports.
const ALLOWED_VARS = new Set(['BASE_SHA']);
// Prefixed onto the one `git fetch` that authenticates through git's environment.
const GIT_FETCH_VARS = new Set(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
// Env keys that change what a command resolves to or loads.
const DANGEROUS_ENV = /^(NODE_OPTIONS|PATH|BASH_ENV|ENV|LD_.*)$/;

const load = (text: string) => parse(text) as Workflow;
const label = (s: Step) => s.name ?? s.uses ?? (s.run ?? '').trim().split('\n')[0] ?? '';
const unquote = (w: string) => w.replace(/^["']+|["']+$/g, '');

interface Command {
  assigns: string[];
  argv: string[];
  redirects: string[];
}

// Where a redirect may write: nowhere, a descriptor, the runner's temp dir, and
// the three files the real workflow writes (its own outputs, in the workspace).
const REDIRECT_TARGETS = new Set(['/dev/null', '&1', '&2', 'open-prs.json', 'refs.txt', '"$GITHUB_OUTPUT"']);
const redirectOk = (t: string) =>
  REDIRECT_TARGETS.has(t) || (/^"?\$RUNNER_TEMP(\/|"|$)/.test(t) && !t.includes('..'));

/** Hoist `$(...)` bodies out as commands of their own, innermost first. */
function hoist(text: string): string[] {
  const parts: string[] = [];
  let t = text;
  for (;;) {
    const next = t.replace(/\$\(([^()]*)\)/, (_m, inner: string) => {
      parts.push(inner);
      return `SUBST${parts.length}`;
    });
    if (next === t) break;
    t = next;
  }
  return [t, ...parts];
}

/** The commands of a `run:` block: leading assignments and argv, redirections removed. */
function commands(run: string): Command[] {
  const text = run
    .replace(/\\\n/g, ' ')
    .replace(/\$\{\{[\s\S]*?\}\}/g, 'EXPR')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const out: Command[] = [];
  for (const chunk of hoist(text)) {
    for (const seg of chunk.split(/\n|;|&&|\|\||\||(?<![>&])&(?![>&])|`|\(|\)|\{\s|\s\}/)) {
      let tokens: string[] = seg.match(/(?:"[^"]*"?|'[^']*'?|[^\s"'])+/g) ?? [];
      while (tokens.length && SHELL_KEYWORDS.has(tokens[0] ?? '')) tokens = tokens.slice(1);
      const words: string[] = [];
      const redirects: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i] ?? '';
        const redirect = /^\d*(?:>>?|<<?|>&|<&|&>)(.*)$/.exec(tok);
        if (!redirect) words.push(tok);
        else if (redirect[1]) redirects.push(redirect[1]);
        else redirects.push(tokens[++i] ?? '');
      }
      const assigns: string[] = [];
      while (words.length && /^[A-Za-z_]\w*=/.test(words[0] ?? '')) assigns.push((words.shift() ?? '').split('=')[0] ?? '');
      if (assigns.length || words.length || redirects.length) out.push({ assigns, argv: words, redirects });
    }
  }
  return out;
}

/** Why a command is not allowed, or null when it is. */
function rejectCommand({ assigns, argv }: Command): string | null {
  const cmd = unquote(argv[0] ?? '');
  const isFetch = cmd === 'git' && unquote(argv[1] ?? '') === 'fetch';
  for (const name of assigns) {
    if (!ALLOWED_VARS.has(name) && !(isFetch && GIT_FETCH_VARS.has(name))) return `assignment not allowed: ${name}`;
  }
  if (!cmd) return null;
  if (cmd === 'node') {
    // No flags at all: --import=, -r./x and --require take code from anywhere.
    const script = unquote(argv[1] ?? '');
    if (!script.startsWith(BASE_SCRIPTS) || script.includes('..')) {
      return `node must run a script under ${BASE_SCRIPTS} as its first word, got ${argv.slice(1).join(' ') || 'nothing'}`;
    }
    return null;
  }
  if (cmd === 'set') {
    const args = argv.slice(1).map(unquote);
    const ok = args.every((a, i) => /^-[euo]+$/.test(a) || (a === 'pipefail' && /o$/.test(args[i - 1] ?? '')));
    return ok ? null : `set takes only -e/-u/-o pipefail: ${argv.join(' ')}`;
  }
  if (cmd === 'export') {
    const bad = argv.slice(1).map((a) => unquote(a).split('=')[0] ?? '').filter((n) => !ALLOWED_VARS.has(n));
    return bad.length ? `export not allowed: ${bad.join(' ')}` : null;
  }
  return ALLOWED_COMMANDS.has(cmd) ? null : `command not allowed: ${argv.join(' ')}`;
}

/** Every step that runs something the job does not allow, with the reason. */
function violations(text: string): string[] {
  const out: string[] = [];
  const wf = load(text);
  for (const [where, env] of [['workflow', wf.env], ['job', wf.jobs.checks.env]] as const) {
    for (const k of Object.keys(env ?? {})) if (DANGEROUS_ENV.test(k)) out.push(`${where} env: ${k} changes what commands run`);
  }
  for (const [where, d] of [['workflow', wf.defaults], ['job', wf.jobs.checks.defaults]] as const) {
    if (d?.run?.shell !== undefined && d.run.shell !== 'bash') out.push(`${where} defaults.run.shell must be bash`);
    if (d?.run?.['working-directory'] !== undefined) out.push(`${where} defaults.run.working-directory is not allowed`);
  }
  for (const s of wf.jobs.checks.steps) {
    if (s.shell !== undefined && s.shell !== 'bash') out.push(`${label(s)}: shell must be bash`);
    if (s['working-directory'] !== undefined) out.push(`${label(s)}: working-directory is not allowed`);
    if (s.uses && (s.uses.startsWith('.') || s.uses.startsWith('docker://'))) {
      out.push(`${label(s)}: uses ${s.uses} runs code from the pull request`);
    }
    for (const k of Object.keys(s.env ?? {})) if (DANGEROUS_ENV.test(k)) out.push(`${label(s)}: env ${k} changes what commands run`);
    const code = (s.run ?? '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    if (/GITHUB_(ENV|PATH)/.test(code)) out.push(`${label(s)}: writes to GITHUB_ENV or GITHUB_PATH`);
    for (const c of commands(s.run ?? '')) {
      const why = rejectCommand(c);
      if (why) out.push(`${label(s)}: ${why}`);
      for (const t of c.redirects) if (!redirectOk(t)) out.push(`${label(s)}: redirect to ${t || 'nothing'} not allowed`);
    }
  }
  return out;
}

/** Steps holding the token: it appears in their own env, with or run, or in a job- or workflow-level env. */
function tokenHolders(text: string): string[] {
  const wf = load(text);
  const inherited = TOKEN.test(JSON.stringify(wf.env ?? {}) + JSON.stringify(wf.jobs.checks.env ?? {}));
  return wf.jobs.checks.steps.filter((s) => inherited || TOKEN.test(JSON.stringify(s))).map(label);
}

/** What is wrong with the `base-scripts` checkout, or [] when it is sound. */
function checkoutProblems(text: string): string[] {
  const steps = load(text).jobs.checks.steps;
  const at = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@') && s.with?.path === 'base-scripts');
  if (at < 0) return ['no base-scripts checkout'];
  const w = steps[at]?.with ?? {};
  const out: string[] = [];
  if (w['persist-credentials'] !== false) out.push('persist-credentials is not false');
  const ref = String(w.ref);
  if (!ref.includes('github.event.pull_request.base.sha')) out.push('ref lacks the base sha');
  if (!ref.includes('|| github.sha')) out.push('ref lacks the `|| github.sha` fallback');
  if (w['sparse-checkout'] !== 'scripts') out.push('sparse-checkout is not `scripts`');
  const first = steps.findIndex((s) => /base-scripts\//.test(s.run ?? ''));
  if (first >= 0 && first < at) out.push(`step "${label(steps[first] as Step)}" invokes base-scripts/ before the checkout`);
  return out;
}

const real = readFileSync(FILE, 'utf8');
/** The real workflow with one exact fragment replaced; throws if it is not there. */
const mutate = (from: string, to: string) => {
  if (!real.includes(from)) throw new Error(`fixture drifted: ${from}`);
  return real.replace(from, to);
};
const CENSUS = 'node base-scripts/scripts/test-census.mjs';
const CENSUS_STEP = 'Count the tests on both sides';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';
const NODE_MSG = `${CENSUS_STEP}: node must run a script under`;
/** The census step's violations with its node command replaced. */
const census = (to: string) => violations(mutate(CENSUS, to)).join('\n');

describe('pr-checks.yml runs only what the allowlist names', () => {
  it('the real workflow is clean, has steps to scan and token-holding ones', () => {
    expect(load(real).jobs.checks.steps.length).toBeGreaterThan(3);
    expect(tokenHolders(real).length).toBeGreaterThan(0);
    expect(violations(real)).toEqual([]);
    expect(checkoutProblems(real)).toEqual([]);
  });

  it('both scripts run from base-scripts/', () => {
    const runs = load(real).jobs.checks.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toMatch(/node base-scripts\/scripts\/test-census\.mjs/);
    expect(runs).toMatch(/node base-scripts\/scripts\/pr-contention\.mjs/);
  });

  it('the log names the base sha the scripts came from', () => {
    const log = load(real).jobs.checks.steps.find((s) => /rev-parse HEAD/.test(s.run ?? '') && /base-scripts/.test(s.run ?? ''));
    expect(log).toBeDefined();
  });

  it('rejects node with a flag before a branch script', () => {
    expect(census('node --no-warnings scripts/test-census.mjs')).toContain(NODE_MSG);
  });

  it('rejects a quoted branch script', () => {
    expect(census('node "scripts/test-census.mjs"')).toContain(NODE_MSG);
  });

  it('rejects a branch script reached through $PWD', () => {
    expect(census('node $PWD/scripts/test-census.mjs')).toContain(NODE_MSG);
  });

  it('rejects a flag that loads branch code ahead of a base script', () => {
    expect(census(`node --require ./evil.js ${CENSUS.slice(5)}`)).toContain(NODE_MSG);
  });

  it('rejects --import=./evil.mjs joined with =', () => {
    expect(census(`node --import=./evil.mjs ${CENSUS.slice(5)}`)).toContain(NODE_MSG);
  });

  it('rejects -r./evil.js attached to its value', () => {
    expect(census(`node -r./evil.js ${CENSUS.slice(5)}`)).toContain(NODE_MSG);
  });

  it('rejects a flag whose value is a base script, leaving a branch script to run', () => {
    expect(census('node --require base-scripts/scripts/test-census.mjs ./scripts/evil.mjs')).toContain(NODE_MSG);
  });

  it('rejects a base-scripts path that climbs out with ..', () => {
    expect(census('node base-scripts/scripts/../../scripts/test-census.mjs')).toContain(NODE_MSG);
  });

  it('rejects bash on a repo script', () => {
    expect(census('bash scripts/x.sh')).toContain(`${CENSUS_STEP}: command not allowed: bash scripts/x.sh`);
  });

  it('rejects npm run', () => {
    expect(census('npm run x')).toContain(`${CENSUS_STEP}: command not allowed: npm run x`);
  });

  it('rejects npx', () => {
    expect(census('npx x')).toContain(`${CENSUS_STEP}: command not allowed: npx x`);
  });

  it('rejects a command behind a leading redirection to a file', () => {
    expect(census('>/dev/null npm run x')).toContain('command not allowed: npm run x');
  });

  it('rejects a command behind a leading fd redirection', () => {
    expect(census('2>&1 bash scripts/x.sh')).toContain('command not allowed: bash scripts/x.sh');
  });

  it('rejects a command behind a leading redirection with a separate target', () => {
    expect(census('> out.txt npx x')).toContain('command not allowed: npx x');
  });

  it('rejects a local action', () => {
    const v = violations(mutate(`- uses: ${SETUP_NODE} # v7.1.0`, '- uses: ./.github/actions/x'));
    expect(v.join('\n')).toContain('uses ./.github/actions/x');
  });

  it('rejects a branch command hidden after && among allowed ones', () => {
    const v = violations(mutate('run: echo "pr checks scripts', 'run: echo hi && npm run x && echo "pr checks scripts'));
    expect(v.join('\n')).toContain('command not allowed: npm run x');
  });

  it('rejects a branch command inside $( )', () => {
    const v = violations(mutate('run: echo "pr checks scripts', 'run: echo "$(npm run x)" "pr checks scripts'));
    expect(v.join('\n')).toContain('command not allowed: npm run x');
  });

  it('rejects set with anything but -e, -u, -o pipefail', () => {
    expect(census('set -x')).toContain('set takes only');
    expect(census('set -- x')).toContain('set takes only');
    expect(census('set -a')).toContain('set takes only');
  });

  it('allows set -euo pipefail and set -e', () => {
    expect(census('set -euo pipefail;')).not.toContain('set takes only');
    expect(census('set -e;')).not.toContain('set takes only');
  });

  it('rejects export PATH', () => {
    expect(census('export PATH="$PWD/scripts:$PATH"')).toContain('export not allowed: PATH');
  });

  it('rejects export NODE_OPTIONS', () => {
    expect(census('export NODE_OPTIONS=--require=./evil.js')).toContain('export not allowed: NODE_OPTIONS');
  });

  it('rejects export BASH_ENV and LD_PRELOAD', () => {
    expect(census('export BASH_ENV=./x')).toContain('export not allowed: BASH_ENV');
    expect(census('export LD_PRELOAD=./x.so')).toContain('export not allowed: LD_PRELOAD');
  });

  it('rejects export of a GH_ or GIT_ variable', () => {
    expect(census('export GH_TOKEN=x')).toContain('export not allowed: GH_TOKEN');
    expect(census('export GIT_CONFIG_COUNT=1')).toContain('export not allowed: GIT_CONFIG_COUNT');
  });

  it('rejects a NODE_OPTIONS assignment in front of an allowed node command', () => {
    expect(census(`NODE_OPTIONS=--require=./evil.js ${CENSUS}`)).toContain('assignment not allowed: NODE_OPTIONS');
  });

  it('rejects a PATH assignment in front of an allowed command', () => {
    expect(census('PATH=$PWD/bin:$PATH git status')).toContain('assignment not allowed: PATH');
  });

  it('rejects the git fetch variables in front of anything but git fetch', () => {
    expect(census('GIT_CONFIG_COUNT=1 echo hi')).toContain('assignment not allowed: GIT_CONFIG_COUNT');
    expect(census('GIT_CONFIG_COUNT=1 git status')).toContain('assignment not allowed: GIT_CONFIG_COUNT');
  });

  it('rejects an assignment on its own line that changes PATH', () => {
    expect(census('PATH=$PWD/bin:$PATH')).toContain('assignment not allowed: PATH');
  });

  it('rejects a redirect to GITHUB_ENV', () => {
    expect(census('echo NODE_OPTIONS=--require=./x >> $GITHUB_ENV')).toContain('writes to GITHUB_ENV or GITHUB_PATH');
  });

  it('rejects a redirect to GITHUB_PATH, quoted or braced', () => {
    expect(census('echo "$PWD/bin" >> "$GITHUB_PATH"')).toContain('writes to GITHUB_ENV or GITHUB_PATH');
    expect(census('echo x >>"${GITHUB_PATH}"')).toContain('writes to GITHUB_ENV or GITHUB_PATH');
  });

  it('rejects a step env naming NODE_OPTIONS', () => {
    const v = violations(mutate('PR_BODY: ${{ github.event.pull_request.body }}', 'PR_BODY: x\n          NODE_OPTIONS: --require=./evil.js'));
    expect(v.join('\n')).toContain(`${CENSUS_STEP}: env NODE_OPTIONS`);
  });

  it('rejects a step env naming PATH or BASH_ENV', () => {
    const p = violations(mutate('PR_BODY: ${{ github.event.pull_request.body }}', 'PR_BODY: x\n          PATH: ./bin'));
    expect(p.join('\n')).toContain(`${CENSUS_STEP}: env PATH`);
    const b = violations(mutate('PR_BODY: ${{ github.event.pull_request.body }}', 'PR_BODY: x\n          BASH_ENV: ./x'));
    expect(b.join('\n')).toContain(`${CENSUS_STEP}: env BASH_ENV`);
  });

  it('rejects a step env naming LD_PRELOAD', () => {
    const v = violations(mutate('PR_BODY: ${{ github.event.pull_request.body }}', 'PR_BODY: x\n          LD_PRELOAD: ./x.so'));
    expect(v.join('\n')).toContain(`${CENSUS_STEP}: env LD_PRELOAD`);
  });

  it('rejects a job-level env naming NODE_OPTIONS', () => {
    const v = violations(mutate('    permissions:\n', '    env:\n      NODE_OPTIONS: --require=./x\n    permissions:\n'));
    expect(v.join('\n')).toContain('job env: NODE_OPTIONS');
  });

  it('rejects a background & before a branch command', () => {
    expect(census('echo hi & npm run x')).toContain('command not allowed: npm run x');
    expect(census('echo hi & node scripts/evil.mjs')).toContain(NODE_MSG);
  });

  it('still reads 2>&1, &> and >& as redirections, not as background', () => {
    expect(census('echo hi 2>&1;')).not.toContain('redirect');
    expect(census('echo hi >/dev/null 2>&1;')).not.toContain('redirect');
    expect(census('echo hi &>/dev/null;')).not.toContain('redirect');
    expect(census('echo hi >&2;')).not.toContain('redirect');
  });

  it('rejects a step shell that runs a script', () => {
    const v = violations(mutate("        if: github.event_name == 'pull_request'\n        env:", "        if: github.event_name == 'pull_request'\n        shell: bash scripts/x.sh {0}\n        env:"));
    expect(v.join('\n')).toContain(`${CENSUS_STEP}: shell must be bash`);
  });

  it('rejects a job defaults.run.shell that runs a script', () => {
    const v = violations(mutate('    permissions:\n', '    defaults:\n      run:\n        shell: node scripts/x.mjs {0}\n    permissions:\n'));
    expect(v.join('\n')).toContain('job defaults.run.shell must be bash');
  });

  it('rejects a workflow defaults.run.shell that runs a script', () => {
    const v = violations(mutate('jobs:\n  checks:', 'defaults:\n  run:\n    shell: node scripts/x.mjs {0}\n\njobs:\n  checks:'));
    expect(v.join('\n')).toContain('workflow defaults.run.shell must be bash');
  });

  it('rejects working-directory on a step or in defaults', () => {
    const t = mutate("        if: github.event_name == 'pull_request'\n        env:", "        if: github.event_name == 'pull_request'\n        working-directory: scripts\n        env:");
    expect(violations(t).join('\n')).toContain(`${CENSUS_STEP}: working-directory is not allowed`);
    const d = mutate('    permissions:\n', '    defaults:\n      run:\n        working-directory: scripts\n    permissions:\n');
    expect(violations(d).join('\n')).toContain('job defaults.run.working-directory is not allowed');
  });

  it('allows an explicit shell: bash', () => {
    const t = mutate("        if: github.event_name == 'pull_request'\n        env:", "        if: github.event_name == 'pull_request'\n        shell: bash\n        env:");
    expect(violations(t)).toEqual([]);
  });

  it('rejects a redirect into .git/config', () => {
    expect(census('echo x >> .git/config;')).toContain('redirect to .git/config not allowed');
  });

  it('rejects a redirect into a git hook', () => {
    expect(census('printf x > .git/hooks/pre-commit;')).toContain('redirect to .git/hooks/pre-commit not allowed');
  });

  it('allows redirects to /dev/null and $RUNNER_TEMP, and rejects one climbing out of it', () => {
    expect(census('echo x > "$RUNNER_TEMP/out";')).not.toContain('redirect');
    expect(census('echo x > $RUNNER_TEMP/out;')).not.toContain('redirect');
    expect(census('echo x > "$RUNNER_TEMP/../../x";')).toContain('redirect to');
  });

  it('counts a token interpolated into a run: as held', () => {
    const t = mutate('run: echo "pr checks scripts', 'run: echo "${{ github.token }}" "pr checks scripts');
    expect(tokenHolders(t)).toContain('Say which commit the scripts came from');
    expect(tokenHolders(real)).not.toContain('Say which commit the scripts came from');
  });

  it('counts secrets.* interpolated into with: as held', () => {
    const t = mutate('node-version: 22', 'node-version: ${{ secrets.X }}');
    expect(tokenHolders(t)).toContain(SETUP_NODE);
    expect(tokenHolders(real)).not.toContain(SETUP_NODE);
  });

  it('counts a job-level env holding the token as every step holding it', () => {
    const t = mutate('    permissions:\n', '    env:\n      T: ${{ github.token }}\n    permissions:\n');
    expect(tokenHolders(t)).toEqual(load(t).jobs.checks.steps.map(label));
  });

  it('asserts the || github.sha fallback', () => {
    const t = mutate('ref: ${{ github.event.pull_request.base.sha || github.sha }}', 'ref: ${{ github.event.pull_request.base.sha }}');
    expect(checkoutProblems(t)).toContain('ref lacks the `|| github.sha` fallback');
  });

  it('asserts sparse-checkout: scripts', () => {
    const t = mutate('sparse-checkout: scripts', 'sparse-checkout: .');
    expect(checkoutProblems(t)).toContain('sparse-checkout is not `scripts`');
  });

  it('asserts the checkout comes before the first step invoking base-scripts/', () => {
    const early = '      - name: Early\n        run: node base-scripts/scripts/test-census.mjs\n\n';
    const t = mutate('      # The scripts that run in this job come from here', `${early}      # The scripts that run in this job come from here`);
    expect(checkoutProblems(t)).toContain('step "Early" invokes base-scripts/ before the checkout');
  });

  it('asserts the checkout is credential-less', () => {
    const t = mutate('sparse-checkout: scripts\n          persist-credentials: false', 'sparse-checkout: scripts');
    expect(checkoutProblems(t)).toContain('persist-credentials is not false');
  });
});
