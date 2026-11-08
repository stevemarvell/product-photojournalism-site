// Run each app's own checks, as project.json declares them.
//
// `npm run verify` is the contract. Each app lists its own `verify` commands
// in project.json, run from its own directory in project.json order, so the
// AI layer's one required gate never has to know the application's layout
// by hand. This stops at the first failure. The AI layer's own checks are
// `verify:harness`, run first.
//
// Usage:
//     node scripts/verify-apps.mjs          # every app
//     node scripts/verify-apps.mjs api web  # just these
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, apps, loadProject } from './project.mjs';

/** The commands to run, in order: [{ app, cwd, command }]. Throws on an unknown app. */
export function plan(project, names = []) {
  const known = new Map(apps(project));
  for (const name of names) {
    if (!known.has(name)) throw new Error(`no app named "${name}" in project.json (have: ${[...known.keys()].join(', ') || 'none: it declares no apps'})`);
  }
  const chosen = names.length ? names : [...known.keys()];
  return chosen.flatMap((name) => {
    const app = known.get(name);
    return (app.verify ?? []).map((command) => ({ app: name, cwd: app.path, command }));
  });
}

/**
 * Why `steps` is empty, as a line to print, or null when there is something to
 * run. An engine-only product declares no apps, and `verify:apps` passing
 * there has to say it ran nothing, not look like it ran something.
 */
export function nothingToRun(project, steps) {
  if (steps.length > 0) return null;
  return apps(project).length === 0
    ? 'verify:apps: project.json declares no apps; nothing to run'
    : 'verify:apps: no app declares any verify command; nothing to run';
}

/** Run the plan; returns the step that failed, or null. `exec` is injectable for tests. */
export function run(steps, { exec = execSync, log = console.log } = {}) {
  for (const step of steps) {
    log(`\n> verify ${step.app}: ${step.command}`);
    try {
      // Through a shell on purpose: the commands are npm and uv invocations
      // from project.json, and npm is a .cmd shim on Windows.
      exec(step.command, { cwd: join(ROOT, step.cwd), stdio: 'inherit' });
    } catch {
      return step;
    }
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let steps;
  try {
    steps = plan(loadProject(), process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const empty = nothingToRun(loadProject(), steps);
  if (empty) console.log(empty);
  const failed = run(steps);
  if (failed) {
    console.error(`\nverify ${failed.app} failed at: ${failed.command}`);
    process.exit(1);
  }
}
