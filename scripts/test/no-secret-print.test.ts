import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The repository is public, so a workflow log is public the moment it is
// written. GitHub masks only the exact secret value, and the Grafana credential
// is base64-encoded into a header inside the telemetry settings file, which the
// mask does not match. So the control is that no step prints the secret, the
// file, or the environment that holds it; docs/data-governance.md names this
// test as that control. It reads the files CI runs; it does not copy their
// logic. It is textual and a backstop, not a proof: a print hidden behind a
// variable it cannot follow will get past it.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

const SECRET = 'GRAFANA_CLOUD_OTLP_AUTH';
const SETTINGS_FILE = /claude-ci-telemetry-settings|telemetry-settings\.json|OTEL_EXPORTER_OTLP_HEADERS/;

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface Job {
  env?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

/** A shell line without its comment. */
const code = (line: string) => line.replace(/(^|\s)#.*$/, '').trim();

const holdsSecret = (...envs: (Record<string, unknown> | undefined)[]) =>
  envs.some((env) => env && SECRET in env);

/** Everything wrong with the `run:` scripts of a workflow, as `job/step: why`. */
function workflowPrints(source: string): string[] {
  const wf = parse(source) as Workflow;
  const found: string[] = [];
  if (/ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG/.test(source.replace(/^\s*#.*$/gm, '')))
    found.push('workflow: sets a step-debug variable');
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    for (const [i, step] of (job.steps ?? []).entries()) {
      const at = `${jobName}/${step.name ?? i}`;
      const lines = String(step.run ?? '').split('\n').map(code).filter(Boolean);
      const secretInScope = holdsSecret(wf.env, job.env, step.env);
      for (const [key, value] of Object.entries(step.with ?? {})) {
        const text = String(value);
        if (secretInScope && /show_full_output/.test(key) && /true/i.test(text))
          found.push(`${at}: with.${key} prints the whole session where ${SECRET} is set`);
        if (secretInScope && /(^|\s)--(verbose|debug)\b/.test(text))
          found.push(`${at}: with.${key} turns on --verbose/--debug where ${SECRET} is set`);
      }
      for (const line of lines) {
        const print = /(^|[\s;&|(])(cat|echo|printf|printenv|tee|head|tail|less|more|xxd|od|base64|jq|print|python3?\s+-c|node\s+-e)\b/.test(line);
        if (line.includes(SECRET) && (print || /secrets\./.test(line))) found.push(`${at}: names ${SECRET} in a command`);
        if (print && SETTINGS_FILE.test(line)) found.push(`${at}: prints the telemetry settings file`);
        if (/secrets\.GRAFANA_CLOUD/.test(line)) found.push(`${at}: interpolates a Grafana secret into a script`);
        if (secretInScope && /(^|[\s;&|(])(env|printenv|export\s+-p|declare\s+-x|set)\s*($|[|;&>])/.test(line))
          found.push(`${at}: dumps the environment where ${SECRET} is set`);
        if (secretInScope && /\bprintenv\b|\bdeclare\s+-[a-zA-Z]*p|\bexport\s+-p\b/.test(line))
          found.push(`${at}: prints variables where ${SECRET} is set`);
        if (secretInScope && /\b(curl|wget)\b.*(\s-[a-zA-Z]*v\b|--verbose|--trace|--debug|\s-d\b)/.test(line))
          found.push(`${at}: runs a verbose HTTP client where ${SECRET} is set`);
        if (secretInScope && /\bset\s+(-[a-zA-Z]*x|-o\s+xtrace)|\bbash\s+-[a-zA-Z]*x/.test(line))
          found.push(`${at}: turns on shell tracing where ${SECRET} is set`);
      }
    }
  }
  return found;
}

/** Everything wrong with a script's own printing, as `why`. */
function scriptPrints(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const handlesSecret = new RegExp(`${SECRET}|OTLP_HEADERS`).test(text);
  const found: string[] = [];
  // Each print call's argument text, up to its closing paren.
  const call = /\b(console\.(log|info|warn|error|debug|dir|table)|process\.(stdout|stderr)\.write)\s*\(/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    let depth = 1;
    let i = call.lastIndex;
    for (; i < text.length && depth > 0; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    const args = text.slice(call.lastIndex, i);
    // A script that handles the credential may not print its block, headers
    // or the credential; any script may not print the whole environment.
    const wholeEnv = /\bprocess\.env\b(?!\.|\[)/.test(args);
    const secretish =
      handlesSecret &&
      new RegExp(`${SECRET}|OTLP_HEADERS|\\bblock\\b|\\bheaders?\\b|Authorization|Basic `, 'i').test(args);
    if (wholeEnv || secretish) found.push(`prints ${args.trim().slice(0, 60)}`);
  }
  if (/\b(execSync|execFileSync|spawnSync|spawn)\s*\(\s*['"`](printenv|env)\b/.test(text))
    found.push('spawns env/printenv');
  return found;
}

const workflows = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const scripts = readdirSync(SCRIPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.mjs$/.test(f) && !f.split(/[\\/]/).includes('test') && !f.endsWith('.d.mts'));

describe('no step prints the Grafana credential', () => {
  it('scans the workflows and scripts that exist (not vacuous)', () => {
    expect(workflows).toContain('claude.yml');
    expect(workflows).toContain('claude-code-review.yml');
    expect(scripts).toContain('write-ci-telemetry-settings.mjs');
  });

  it('no workflow prints what a secret-holding step could leak', () => {
    const hits = workflows.flatMap((file) =>
      workflowPrints(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')).map((why) => `${file}: ${why}`),
    );
    expect(hits).toEqual([]);
  });

  it('no script prints a credential, headers or the environment', () => {
    const hits = scripts.flatMap((f) =>
      scriptPrints(readFileSync(join(SCRIPTS_DIR, f), 'utf8')).map((why) => `${f}: ${why}`),
    );
    expect(hits).toEqual([]);
  });

  // Each of these appends one realistic leak to the real file CI runs and
  // expects it to be named; unmutated, the file is clean (above).
  const claude = readFileSync(join(WORKFLOWS_DIR, 'claude.yml'), 'utf8');
  const telemetry = readFileSync(join(SCRIPTS_DIR, 'write-ci-telemetry-settings.mjs'), 'utf8');
  const withStep = (run: string) =>
    claude.replace(
      '        run: node scripts/write-ci-telemetry-settings.mjs',
      `        run: |\n          node scripts/write-ci-telemetry-settings.mjs\n          ${run}`,
    );

  it('catches cat of the settings file', () => {
    const mutated = withStep('cat "${{ runner.temp }}/claude-ci-telemetry-settings.json"');
    expect(mutated).not.toBe(claude);
    expect(workflowPrints(mutated)).toEqual([expect.stringContaining('prints the telemetry settings file')]);
  });

  it('catches echo of the secret', () => {
    const mutated = withStep('echo "$GRAFANA_CLOUD_OTLP_AUTH"');
    expect(workflowPrints(mutated)).toEqual([expect.stringContaining('names GRAFANA_CLOUD_OTLP_AUTH')]);
  });

  it('catches printenv and env', () => {
    for (const cmd of ['printenv', 'env', 'env | sort']) {
      expect(workflowPrints(withStep(cmd))).toEqual(expect.arrayContaining([expect.stringContaining('dumps the environment')]));
    }
  });

  it('catches printenv NAME, declare -p and a verbose curl', () => {
    for (const cmd of ['printenv GRAFANA_CLOUD_OTLP_AUTH', 'declare -p', 'curl -v -H "X: $GRAFANA_CLOUD_OTLP_AUTH" https://example.com']) {
      expect(workflowPrints(withStep(cmd)), cmd).not.toEqual([]);
    }
  });

  it('catches show_full_output and --verbose in the action inputs', () => {
    const full = claude.replace('          claude_code_oauth_token:', '          show_full_output: true\n          claude_code_oauth_token:');
    expect(full).not.toBe(claude);
    expect(workflowPrints(full)).toEqual([expect.stringContaining('show_full_output')]);
    const verbose = claude.replace('            --model sonnet', '            --model sonnet --verbose');
    expect(verbose).not.toBe(claude);
    expect(workflowPrints(verbose)).toEqual([expect.stringContaining('--verbose')]);
  });

  it('catches set -x and ACTIONS_STEP_DEBUG', () => {
    expect(workflowPrints(withStep('set -x'))).toEqual([expect.stringContaining('shell tracing')]);
    expect(workflowPrints(withStep('set -euxo pipefail'))).toEqual([expect.stringContaining('shell tracing')]);
    expect(workflowPrints(claude.replace('env:\n      GRAFANA_CLOUD_OTLP_ENDPOINT', 'env:\n      ACTIONS_STEP_DEBUG: true\n      GRAFANA_CLOUD_OTLP_ENDPOINT'))).toEqual([
      'workflow: sets a step-debug variable',
    ]);
  });

  it('catches the secret interpolated into a script', () => {
    const mutated = withStep('curl -H "X: ${{ secrets.GRAFANA_CLOUD_OTLP_AUTH }}" https://example.com');
    expect(workflowPrints(mutated).length).toBeGreaterThan(0);
  });

  it('ignores the same words in comments and in steps that hold no secret', () => {
    const quiet = claude.replace(
      '        run: node scripts/write-ci-telemetry-settings.mjs',
      '        run: |\n          # cat the settings file? never. set -x? never.\n          node scripts/write-ci-telemetry-settings.mjs',
    );
    expect(workflowPrints(quiet)).toEqual([]);
  });

  it('catches a script logging the block, the headers or the environment', () => {
    for (const leak of ['console.log(block);', 'console.error(JSON.stringify(process.env));', 'process.stdout.write(`${headers}\\n`);']) {
      const mutated = `${telemetry}\n${leak}\n`;
      expect(scriptPrints(mutated).length).toBeGreaterThan(0);
    }
    expect(scriptPrints(telemetry)).toEqual([]);
  });
});
