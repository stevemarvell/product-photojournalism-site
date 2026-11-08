// Turn on Claude Code's built-in sandbox for the two credentialed review
// jobs in claude-code-review.yml, and write the setting the same way
// write-ci-telemetry-settings.mjs already does: to a file outside the
// checkout, merged into the JSON that job's `--settings` flag loads.
//
// Why not `.claude/settings.json`. That file is tracked, reviewed, and
// exactly where a project-wide sandbox default belongs for a laptop session
// — but these jobs review a pull request's *head*, which is untrusted, and
// `claude-code-action` deletes and restores `.claude` from the *base* branch
// immediately before the CLI starts (`restoreConfigFromBase`, the same
// behaviour write-ci-telemetry-settings.mjs's header describes). A
// `sandbox` key added to the tracked file would still apply — the
// restore keeps the base branch's copy — but this project's other
// concurrent work owns that file, and the pattern below is one CI already
// carries for exactly this reason: write outside the checkout, load with
// `--settings`, which this action's own precedence puts above project
// settings anyway.
//
// Why merge into the telemetry file rather than write a second one. Both
// need to reach the same `--settings` flag in claude-code-review.yml, and
// nothing here establishes that the CLI accepts the flag more than once.
// One file, one flag, two concerns written into it by two scripts run in
// sequence, is the shape that does not depend on that being true.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultSettingsPath } from './write-ci-telemetry-settings.mjs';

/**
 * The sandbox configuration for a review job. Every choice here follows from
 * what the job is allowed to do at all: `--allowedTools` in
 * claude-code-review.yml already narrows this job's Bash tool to
 * `gh pr diff` and `gh pr view`, so the sandbox is a second, OS-enforced
 * layer around a Bash surface that is already meant to be narrow — not the
 * only thing standing between a hostile diff and this job's two credentials
 * (the Grafana one and the pull-requests:write token).
 */
export function ciSandboxSettings() {
  return {
    enabled: true,

    // A runner has nobody to answer a permission prompt, and the sandbox's
    // own failure mode when a dependency is missing is to warn and fall back
    // to running unsandboxed — silently, from this job's point of view.
    // `docs/sops.md` SOP 3 is the reason that is not acceptable here: a
    // control that is present, configured, and quietly inert is this
    // repository's recurring defect, not a hypothetical one. Failing the job
    // instead makes a missing dependency a build failure someone has to fix,
    // rather than a review that ran open the whole time.
    failIfUnavailable: true,

    // No retry outside the sandbox. A command the sandbox cannot run is a
    // command this job should not run at all, given what it holds.
    allowUnsandboxedCommands: false,

    network: {
      // Deny a host outside the allowlist outright rather than prompt for
      // it — there is nobody here to answer, and a hung prompt is a stuck
      // job. `strictAllowlist` is honoured from a `--settings` value per
      // Claude Code's own docs, which is the file this gets merged into.
      strictAllowlist: true,

      // `gh pr diff` and `gh pr view` — the only two Bash commands this
      // job's `--allowedTools` permits — talk to the GitHub API and,
      // for `gh`'s own redirects, github.com itself. Nothing else this job
      // runs needs the network at all.
      allowedDomains: ['api.github.com', 'github.com', '*.github.com'],
    },
  };
}

/**
 * Read the settings file the telemetry step already wrote (or start from an
 * empty object if it is missing or unreadable, so this step can still run on
 * its own — in a test, or if the telemetry step is ever reordered), add the
 * `sandbox` key, and write the result back to the same path.
 */
export function mergeCiSandboxSettings(path) {
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    existing = {};
  }
  const sandbox = ciSandboxSettings();
  writeFileSync(path, `${JSON.stringify({ ...existing, sandbox }, null, 2)}\n`);
  return { path, sandbox };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = defaultSettingsPath();
  const { sandbox } = mergeCiSandboxSettings(path);
  console.log(
    `Sandbox settings merged into ${path}: enabled=${sandbox.enabled}, ` +
      `allowedDomains=${sandbox.network.allowedDomains.join(',')}`,
  );
}
