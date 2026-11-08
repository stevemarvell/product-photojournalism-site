// Point a GitHub runner's Claude Code session at Grafana Cloud, by writing a
// settings file the session loads with `--settings` before it starts.
//
// Writing to `.claude/settings.local.json` looks tempting: *project local*
// outranks the committed `.claude/settings.json` and therefore beats the
// endpoint it points at a laptop's collector (`http://localhost:4317`). That
// is correct about Claude Code's own precedence and wrong in practice:
// `claude-code-action` checks out a pull request's head to review it, and —
// because that content is attacker-controlled — restores `.claude`,
// `.mcp.json`, `CLAUDE.md` and a handful of other paths from the base
// branch immediately before the CLI starts (`restoreConfigFromBase` in the
// action's own source). That restore deletes the whole `.claude` directory
// first, including any untracked file under it. A
// `.claude/settings.local.json` written by an earlier workflow step exists
// for a few dozen seconds and is gone before Claude Code ever reads it — CI
// silently falls back to the committed `localhost:4317` instead, so every
// CI session would carry `terminal_type=windows-terminal` and no
// `environment` label at all, indistinguishable from a laptop run.
//
// The fix this time works outside the path the restore can reach. Claude
// Code's settings precedence, highest first, is: managed settings, the
// `--settings` command-line flag, project local, shared project, user
// (https://code.claude.com/docs/en/settings). `--settings` outranks project
// local, so it does not need to survive as a project-local file at all — and
// writing it to `$RUNNER_TEMP` rather than the checkout means
// `restoreConfigFromBase` never touches it, because that function only
// deletes and restores paths under the checked-out working tree.
//
// This also still sidesteps the second limit the project-local approach was
// chosen for: `claude-code-action` forwards exactly nine `OTEL_*` variables
// from `env` into the CLI, and
// `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` is not one of them. A
// value in a settings file arrives regardless of which nine the action
// forwards.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * A credential arriving through a GitHub secret is not attacker-controlled, but
 * it is still text being written into a JSON file that configures a process.
 * A newline in the header value would end up embedded in an HTTP header; an
 * endpoint carrying control characters would not be the host anyone intended.
 * Both are cheap to refuse and expensive to debug.
 */
export function assertClean(value, context) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`${context} contains control characters`);
    }
  }
}

function assertValidEndpoint(endpoint) {
  assertClean(endpoint, 'GRAFANA_CLOUD_OTLP_ENDPOINT');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`GRAFANA_CLOUD_OTLP_ENDPOINT is not a URL: ${endpoint}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`GRAFANA_CLOUD_OTLP_ENDPOINT must be https, got ${url.protocol}`);
  }
}

/**
 * The header is spelled as the OTel SDK wants it — "Authorization=Basic <b64>",
 * a comma-separated list of key=value pairs — which differs from the bare
 * "Basic <b64>" the collector's own config takes. Getting the two the wrong way
 * round produces a 401 that reads exactly like a bad token, so the shape is
 * checked here rather than discovered later.
 */
function assertValidAuthHeader(header) {
  assertClean(header, 'GRAFANA_CLOUD_OTLP_AUTH');
  if (!/^[A-Za-z0-9_-]+=/.test(header)) {
    throw new Error(
      'GRAFANA_CLOUD_OTLP_AUTH must be key=value, e.g. "Authorization=Basic <base64>". ' +
        'A bare "Basic <base64>" is the collector spelling, not the SDK one.',
    );
  }
}

/**
 * Build the `env` block for the session. Without a credential the block exists
 * anyway and switches telemetry off: leaving it absent would let the committed
 * settings.json apply, and a runner would spend the job retrying a connection
 * to its own localhost.
 */
export function ciTelemetryEnv(env = process.env) {
  const endpoint = env.GRAFANA_CLOUD_OTLP_ENDPOINT ?? '';
  const auth = env.GRAFANA_CLOUD_OTLP_AUTH ?? '';

  if (!endpoint || !auth) {
    return { CLAUDE_CODE_ENABLE_TELEMETRY: '0' };
  }

  assertValidEndpoint(endpoint);
  assertValidAuthHeader(auth);

  const attributes = [
    'environment=ci',
    'ci_provider=github-actions',
    `workflow=${env.CI_TELEMETRY_WORKFLOW || 'unknown'}`,
    `run_id=${env.GITHUB_RUN_ID || 'unknown'}`,
    `run_attempt=${env.GITHUB_RUN_ATTEMPT || 'unknown'}`,
  ];
  assertClean(attributes.join(','), 'CI_TELEMETRY_WORKFLOW');

  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',

    // Events as well as metrics: the Grafana Cloud integration's dashboards
    // read both. What turns an event from "which tool ran, how long, which
    // model" into the prompt and the file contents is OTEL_LOG_USER_PROMPTS,
    // OTEL_LOG_TOOL_DETAILS and OTEL_LOG_TOOL_CONTENT — none of which is set
    // anywhere in this repository, and all of which must stay absent. Unset is
    // off, and absent cannot be misread the way "0" can.
    OTEL_LOGS_EXPORTER: 'otlp',

    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',

    // Required by the Grafana integration. Claude Code can emit delta
    // temporality, which a Prometheus-backed store drops without a word — the
    // symptom is every panel reading "No data" and nothing in any log to
    // explain it. This is also one of the variables claude-code-action does
    // not forward, so the workflow could not set it even if it tried.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',

    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: auth,

    // 5s rather than the 10s used locally. A runner is destroyed the moment the
    // job ends and a flush on exit is not documented, so a short review could
    // otherwise finish between exports and report nothing at all.
    OTEL_METRIC_EXPORT_INTERVAL: '5000',
    OTEL_LOGS_EXPORT_INTERVAL: '5000',

    // Without this split, CI spend is indistinguishable from laptop spend in
    // the same store and "tokens per merged pull request" quietly absorbs the
    // review bot.
    OTEL_RESOURCE_ATTRIBUTES: attributes.join(','),
  };
}

/**
 * Where the settings file goes: outside the checked-out working tree, so
 * `claude-code-action`'s restore of PR-untrusted paths (which operates on
 * `.claude` and friends inside the checkout, not on `$RUNNER_TEMP`) cannot
 * reach it. `RUNNER_TEMP` is set on every GitHub Actions runner; `tmpdir()`
 * is the fallback for running this outside CI (locally, or in this file's
 * own tests).
 */
export function defaultSettingsPath(env = process.env) {
  return join(env.RUNNER_TEMP || tmpdir(), 'claude-ci-telemetry-settings.json');
}

export function writeCiTelemetrySettings(env = process.env, path = defaultSettingsPath(env)) {
  const block = ciTelemetryEnv(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ env: block }, null, 2)}\n`);
  return { path, enabled: block.CLAUDE_CODE_ENABLE_TELEMETRY === '1' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { path, enabled } = writeCiTelemetrySettings();
  // Never print the block itself; it carries the credential.
  console.log(
    enabled
      ? `Telemetry on: wrote ${path} for this session's --settings flag to load.`
      : `Telemetry off: wrote ${path} with CLAUDE_CODE_ENABLE_TELEMETRY=0 (no credential).`,
  );
}
