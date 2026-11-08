import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ciSandboxSettings, mergeCiSandboxSettings } from '../write-ci-sandbox-settings.mjs';

let dir = '';
const settingsPath = () => join(dir, 'claude-ci-telemetry-settings.json');
const read = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-sandbox-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ciSandboxSettings', () => {
  it('enables the sandbox and refuses to fall back to running unsandboxed', () => {
    const sandbox = ciSandboxSettings();
    expect(sandbox.enabled).toBe(true);
    // The job's own failure mode when a dependency is missing must be
    // "fail the build", not "warn and review the diff unsandboxed" — a
    // control that quietly does nothing is the repeat defect docs/sops.md
    // SOP 3 tracks.
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
  });

  it('locks the network allowlist to the hosts gh needs, and denies rather than prompts for anything else', () => {
    const sandbox = ciSandboxSettings();
    expect(sandbox.network.strictAllowlist).toBe(true);
    expect(sandbox.network.allowedDomains).toEqual(
      expect.arrayContaining(['api.github.com', 'github.com']),
    );
  });
});

describe('mergeCiSandboxSettings', () => {
  it('adds a sandbox key alongside the env block the telemetry step already wrote', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }),
    );

    const result = mergeCiSandboxSettings(settingsPath());

    expect(result.sandbox.enabled).toBe(true);
    const written = read();
    // The telemetry block survives the merge — this step must not clobber
    // what write-ci-telemetry-settings.mjs already wrote to the same file.
    expect(written.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(written.sandbox.enabled).toBe(true);
    expect(written.sandbox.network.allowedDomains).toContain('api.github.com');
  });

  it('still writes a usable settings file when the telemetry step has not run first', () => {
    // Order in the workflow should not be load-bearing: a settings file with
    // only `sandbox` and no `env` is still valid input to `--settings`.
    const result = mergeCiSandboxSettings(settingsPath());
    expect(result.sandbox.enabled).toBe(true);
    expect(read()).toEqual({ sandbox: ciSandboxSettings() });
  });
});
