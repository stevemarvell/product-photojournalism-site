import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ciTelemetryEnv,
  defaultSettingsPath,
  writeCiTelemetrySettings,
} from '../write-ci-telemetry-settings.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** True when `path` is the repository working tree itself, or anything inside it. */
const insideCheckout = (path: string) => {
  const offset = relative(REPO_ROOT, resolve(path));
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
};

const CREDENTIAL = {
  GRAFANA_CLOUD_OTLP_ENDPOINT: 'https://otlp-gateway-prod-gb-south-1.grafana.net/otlp',
  GRAFANA_CLOUD_OTLP_AUTH: 'Authorization=Basic aW5zdGFuY2U6dG9rZW4=',
};

let dir = '';
const settingsPath = () => join(dir, 'claude-ci-telemetry-settings.json');
const read = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-telemetry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ciTelemetryEnv', () => {
  it('points the session at Grafana Cloud when the credential is present', () => {
    const env = ciTelemetryEnv({
      ...CREDENTIAL,
      CI_TELEMETRY_WORKFLOW: 'claude-code-review',
      GITHUB_REPOSITORY: 'stevemarvell/product-photojournalism-site',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
    });

    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(CREDENTIAL.GRAFANA_CLOUD_OTLP_ENDPOINT);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(CREDENTIAL.GRAFANA_CLOUD_OTLP_AUTH);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'environment=ci,ci_provider=github-actions,repository=stevemarvell/product-photojournalism-site,workflow=claude-code-review,run_id=42,run_attempt=1',
    );
  });

  it('labels the repository as unknown when GITHUB_REPOSITORY is unset', () => {
    expect(ciTelemetryEnv(CREDENTIAL).OTEL_RESOURCE_ATTRIBUTES).toContain(',repository=unknown,');
  });

  it('rejects a repository containing a comma, which would forge an attribute', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_REPOSITORY: 'a/b,evil=1' })).toThrow(/GITHUB_REPOSITORY/);
  });

  it('rejects a repository containing an equals sign', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_REPOSITORY: 'a/b=c' })).toThrow(/GITHUB_REPOSITORY/);
  });

  it('rejects a repository containing a control character', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_REPOSITORY: 'a/b\nc' })).toThrow(/GITHUB_REPOSITORY/);
  });

  it('rejects CI_TELEMETRY_WORKFLOW containing a comma, which would forge an attribute', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, CI_TELEMETRY_WORKFLOW: 'a,evil=1' })).toThrow(/CI_TELEMETRY_WORKFLOW/);
  });

  it('rejects CI_TELEMETRY_WORKFLOW containing an equals sign', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, CI_TELEMETRY_WORKFLOW: 'a=b' })).toThrow(/CI_TELEMETRY_WORKFLOW/);
  });

  it('rejects GITHUB_RUN_ID containing a comma, which would forge an attribute', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_RUN_ID: 'a,evil=1' })).toThrow(/GITHUB_RUN_ID/);
  });

  it('rejects GITHUB_RUN_ID containing an equals sign', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_RUN_ID: 'a=b' })).toThrow(/GITHUB_RUN_ID/);
  });

  it('rejects GITHUB_RUN_ATTEMPT containing a comma, which would forge an attribute', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_RUN_ATTEMPT: 'a,evil=1' })).toThrow(/GITHUB_RUN_ATTEMPT/);
  });

  it('rejects GITHUB_RUN_ATTEMPT containing an equals sign', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GITHUB_RUN_ATTEMPT: 'a=b' })).toThrow(/GITHUB_RUN_ATTEMPT/);
  });

  it('writes no settings file when a value is refused', () => {
    expect(() =>
      writeCiTelemetrySettings({ ...CREDENTIAL, GITHUB_RUN_ID: '1,x=2' }, settingsPath()),
    ).toThrow(/GITHUB_RUN_ID/);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('carries the temporality preference, which the action does not forward', () => {
    // claude-code-action passes exactly nine OTEL_* variables from env into the
    // CLI and this is not one of them. A Prometheus-backed store drops delta
    // sums without logging anything, so its absence looks like a wrong metric
    // name rather than a missing setting.
    const env = ciTelemetryEnv(CREDENTIAL);
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe('cumulative');
  });

  it('never opens the three variables that turn events into content', () => {
    const env = ciTelemetryEnv(CREDENTIAL);
    expect(env).not.toHaveProperty('OTEL_LOG_USER_PROMPTS');
    expect(env).not.toHaveProperty('OTEL_LOG_TOOL_DETAILS');
    expect(env).not.toHaveProperty('OTEL_LOG_TOOL_CONTENT');
  });

  it('switches telemetry off rather than leaving the committed enable flag to apply', () => {
    // The failure this guards: with no block at all, .claude/settings.json
    // enables telemetry on the runner and names the Grafana gateway, so the
    // session sends unauthenticated exports there for the life of the job.
    expect(ciTelemetryEnv({})).toEqual({ CLAUDE_CODE_ENABLE_TELEMETRY: '0' });
    expect(ciTelemetryEnv({ GRAFANA_CLOUD_OTLP_ENDPOINT: CREDENTIAL.GRAFANA_CLOUD_OTLP_ENDPOINT })).toEqual(
      { CLAUDE_CODE_ENABLE_TELEMETRY: '0' },
    );
    expect(ciTelemetryEnv({ GRAFANA_CLOUD_OTLP_AUTH: CREDENTIAL.GRAFANA_CLOUD_OTLP_AUTH })).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '0',
    });
  });

  it('rejects an endpoint that is not https', () => {
    expect(() =>
      ciTelemetryEnv({ ...CREDENTIAL, GRAFANA_CLOUD_OTLP_ENDPOINT: 'http://otlp.example/otlp' }),
    ).toThrow(/must be https/);
  });

  it('rejects an endpoint that is not a URL', () => {
    expect(() => ciTelemetryEnv({ ...CREDENTIAL, GRAFANA_CLOUD_OTLP_ENDPOINT: 'not a url' })).toThrow(
      /is not a URL/,
    );
  });

  it('rejects control characters, which a URL parser would silently strip', () => {
    expect(() =>
      ciTelemetryEnv({
        ...CREDENTIAL,
        GRAFANA_CLOUD_OTLP_ENDPOINT: 'https://otlp.example\n.evil/otlp',
      }),
    ).toThrow(/control characters/);
  });

  it('rejects the collector spelling of the auth header', () => {
    // "Basic <base64>" is what an OpenTelemetry collector's own config takes; the
    // SDK wants "Authorization=Basic <base64>". Swapping them produces a 401
    // that reads exactly like a bad token.
    expect(() =>
      ciTelemetryEnv({ ...CREDENTIAL, GRAFANA_CLOUD_OTLP_AUTH: 'Basic aW5zdGFuY2U6dG9rZW4=' }),
    ).toThrow(/key=value/);
  });
});

describe('committed .claude/settings.json', () => {
  const committed = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

  // Cloud sessions do not receive the environment's OTEL_EXPORTER_OTLP_*
  // variables, so the endpoint and protocol are committed here. Auth stays
  // with the environment's network secret, so no headers are committed.
  it('points at the Grafana Cloud gateway, because cloud sessions do not receive the environment value', () => {
    expect(committed.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      'https://otlp-gateway-prod-gb-south-1.grafana.net/otlp',
    );
    expect(committed.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
  });

  it('commits no OTLP headers; auth is the network secret', () => {
    for (const key of [
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ]) {
      expect(committed.env, key).not.toHaveProperty(key);
    }
  });
});

describe('defaultSettingsPath', () => {
  it('uses RUNNER_TEMP, outside any git checkout, when set', () => {
    expect(defaultSettingsPath({ RUNNER_TEMP: '/home/runner/work/_temp' })).toBe(
      join('/home/runner/work/_temp', 'claude-ci-telemetry-settings.json'),
    );
  });

  it('falls back to the OS temp dir when RUNNER_TEMP is unset, for local and test runs', () => {
    expect(defaultSettingsPath({})).toBe(join(tmpdir(), 'claude-ci-telemetry-settings.json'));
  });

  // The regression this guards against: writing this file to
  // .claude/settings.local.json instead, when claude-code-action deletes the
  // whole .claude directory — restoring only paths tracked on the base
  // branch — immediately before starting the CLI, because a reviewed pull
  // request's head is untrusted. settings.local.json is gitignored, so it
  // never comes back, and CI silently runs without its endpoint and
  // credential, with no line in any log to say so. Asserting the
  // invariant rather than the path: anywhere inside the checkout is
  // reachable by that restore, so anywhere inside the checkout is wrong.
  it('never puts the file inside the checkout, where the action would delete it', () => {
    expect(insideCheckout(defaultSettingsPath({ RUNNER_TEMP: '/home/runner/work/_temp' }))).toBe(
      false,
    );
    expect(insideCheckout(defaultSettingsPath({}))).toBe(false);
    expect(insideCheckout(join(REPO_ROOT, '.claude', 'settings.local.json'))).toBe(true);
  });
});

describe('writeCiTelemetrySettings', () => {
  it('writes a settings file at the given path, meant for --settings rather than a project directory', () => {
    const result = writeCiTelemetrySettings(
      { ...CREDENTIAL, CI_TELEMETRY_WORKFLOW: 'claude-mention' },
      settingsPath(),
    );

    expect(result.enabled).toBe(true);
    expect(result.path).toBe(settingsPath());
    expect(read().env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(CREDENTIAL.GRAFANA_CLOUD_OTLP_ENDPOINT);
    expect(read().env.OTEL_RESOURCE_ATTRIBUTES).toContain('workflow=claude-mention');
  });

  it('writes the off switch when there is no credential', () => {
    const result = writeCiTelemetrySettings({}, settingsPath());

    expect(result.enabled).toBe(false);
    expect(read()).toEqual({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' } });
  });
});
