// Add deployment to an app that doesn't have any. This base's default is
// nothing deployed (project.json has no `deploy` block anywhere); this is
// how a repository built from it opts one app at a time into a provider.
//
// Usage:
//     npm run deploy:add -- vercel --app <app> [--team T --project P --url U --commit-endpoint /x] [--overwrite]
//
// Writes `project.json`'s `apps.<app>.deploy` block, copies that provider's
// template files into place (apps/<app>/vercel.json, and the `deployment`
// skill under apps/<app>/.claude/skills/, inside the app it is about, as a
// starter keeps its own skills) with their placeholders filled in, and
// prints the steps that are a person's to do, not this command's: creating
// the actual Vercel project, turning Deployment Protection's Vercel
// Authentication off, copying the real production URL, and adding
// VERCEL_TOKEN.
//
// It also gives the repository its scheduled smoke run back. The engine's
// .github/workflows/smoke.yml ships with no `schedule:` trigger, because a
// scheduled run starts a runner even with nothing deployed (#254); the first
// deploy:add inserts SMOKE_SCHEDULE directly above `workflow_dispatch:`, and
// a second one, for the same app or another, finds it there and leaves the
// file alone.
//
// Safe to re-run — the sync-ai-layer skill has every sync do it to restore
// the schedule. The `deploy` block is rewritten (values not re-typed are kept)
// and the schedule is only inserted if missing, but apps/<app>/vercel.json and
// the deployment skill are written only when they don't exist: a product
// customises them (rewrites, headers), and a re-run must not undo that. A kept
// file is named in the output. Pass `--overwrite` to replace both from the
// template anyway. An app project.json doesn't declare, or a provider nothing
// here registers, is refused before anything is written.
//
// `--team`, `--project`, `--url` and `--commit-endpoint` are optional: left
// out, each becomes an obvious placeholder (`<team>`, `<project>`, …) rather
// than a guess — the production URL in particular is never inferred from the
// short alias, which this project itself isn't guaranteed to have, so there
// is nothing safe to default it to. Re-run with the real values once they're
// known.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, ROOT, TEMPLATE_HASH_KEYS, hasDeploy, validate } from '../project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every provider this command knows, and where its template files live.
// Distinct from scripts/deploy/index.mjs's registry, which maps a provider
// to the *runtime* functions smoke.mjs calls; this one is only about what to
// scaffold.
const TEMPLATE_DIRS = { vercel: join(HERE, 'vercel/template') };

// The uptime-check trigger smoke.yml gains once something is deployed. The
// cadence is a deliberate cost decision against the account's shared Actions
// minutes: every 3 hours, offset from the hour so it doesn't pile onto :00.
export const SMOKE_SCHEDULE = `  schedule:
    # Every 3 hours, offset from the hour so it doesn't pile onto :00 with
    # everyone else's crons. Added by \`npm run deploy:add\`: the engine ships
    # without it, so nothing here costs a runner minute until an app deploys.
    - cron: '17 */3 * * *'
`;

const SMOKE_WORKFLOW = '.github/workflows/smoke.yml';
const WORKFLOW_DISPATCH = /^ {2}workflow_dispatch:/m;

/** The part of a workflow that holds its triggers: everything before the first top-level `jobs:`. */
function triggers(text) {
  const jobs = text.search(/^jobs:/m);
  return jobs === -1 ? text : text.slice(0, jobs);
}

/** Whether `text` (smoke.yml) has a top-level `schedule:` trigger. A job named `schedule` under `jobs:` is not one. */
export function hasSmokeSchedule(text) {
  return /^ {2}schedule:/m.test(triggers(text));
}

/**
 * `text` (smoke.yml) with SMOKE_SCHEDULE inserted directly above its
 * `workflow_dispatch:` trigger. Returns `text` untouched if a top-level
 * `schedule:` trigger is already there, so a second run changes nothing.
 * Throws if there is neither, rather than guess where a trigger belongs.
 */
export function withSmokeSchedule(text) {
  if (hasSmokeSchedule(text)) return text;
  const at = triggers(text).search(WORKFLOW_DISPATCH);
  if (at === -1) throw new Error(`${SMOKE_WORKFLOW} has no "  workflow_dispatch:" line to put the schedule above`);
  return text.slice(0, at) + SMOKE_SCHEDULE + text.slice(at);
}

/**
 * What is wrong, if anything, between `project` and `text` (smoke.yml): an app
 * with a `deploy` block needs the scheduled uptime check, and smoke.yml is an
 * engine file that a sync copies down without it. Null when all is well,
 * including in the base, where nothing is deployed and nothing is scheduled.
 */
export function smokeScheduleProblem(project, text) {
  if (!hasDeploy(project) || hasSmokeSchedule(text)) return null;
  return (
    `project.json has an app with a deploy block, but ${SMOKE_WORKFLOW} has no top-level "schedule:" trigger, ` +
    'so the uptime check is not running (a sync of the engine copies the base file, which ships without one). ' +
    'Put it back by running `npm run deploy:add` again for that app, or withSmokeSchedule() from scripts/deploy/add.mjs on the file.'
  );
}

// Flags that take no value.
const SWITCHES = { '--overwrite': 'overwrite' };
const FLAGS = { '--app': 'app', '--team': 'team', '--project': 'project', '--url': 'url', '--commit-endpoint': 'commitEndpoint' };

/** Parse `[provider, ...flags]` into `{ provider, app, team?, project?, url?, commitEndpoint?, overwrite? }`. */
export function parseArgs(argv) {
  const [provider, ...rest] = argv;
  if (!provider) throw new Error('usage: deploy:add <provider> --app <app> [--team T --project P --url U --commit-endpoint /x] [--overwrite]');
  const opts = { provider };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (SWITCHES[flag]) {
      opts[SWITCHES[flag]] = true;
      i -= 1; // no value to skip
      continue;
    }
    const key = FLAGS[flag];
    if (!key) throw new Error(`usage: unknown flag "${flag}"`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`usage: ${flag} needs a value`);
    opts[key] = value;
  }
  if (!opts.app) throw new Error('usage: --app <app> is required');
  return opts;
}

/**
 * Fill in whatever wasn't given from `existing` (the app's current `deploy`
 * block, if it has one) and only then with an obvious placeholder, never a
 * guess. This is what makes a partial re-run — passing only the one flag
 * that changed — safe: the values nobody re-typed come from what's already
 * in project.json, not from `<team>`-shaped placeholders overwriting real
 * ones.
 */
export function withPlaceholders({ team, project, url, commitEndpoint, existing = {} }) {
  return {
    team: team ?? existing.team ?? '<team>',
    project: project ?? existing.project ?? '<project>',
    url: url ?? existing.url ?? 'https://<project>.vercel.app',
    commitEndpoint: commitEndpoint ?? existing.commitEndpoint ?? '/health',
  };
}

/** Every `<key>` in `text` replaced by `values[key]`. */
export function renderTemplate(text, values) {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`<${key}>`, value), text);
}

/** The steps that are the owner's to do once this command has run. */
export function ownerSteps({ app, team, project }) {
  return [
    `Create the Vercel project "${project}" (team "${team}") with Root Directory apps/${app}.`,
    'Turn Vercel Authentication off in Deployment Protection.',
    "Copy the production URL from the project's domain list — don't infer it from the short alias — and set it as this app's deploy.url in project.json.",
    'Add a team-scoped VERCEL_TOKEN repository secret before the first pull request that deploys this app closes.',
    "Record VERCEL_TOKEN's expiry in README.md and docs/data-governance.md.",
  ];
}

/** What deploy:add writes per `TEMPLATE_HASH_KEYS` entry: path under the app, template file, and the name it is reported by. */
const TEMPLATE_FILES = {
  vercelJson: { path: 'vercel.json', templateFile: 'vercel.template.json', name: 'vercel.json' },
  skill: { path: '.claude/skills/deployment/SKILL.md', templateFile: 'SKILL.md', name: 'deployment skill' },
};

/**
 * Write `app`'s deploy block and this provider's template files. Returns the
 * filled-in `values`, the manifest written, `changed` ({key: {from, to}} for
 * deploy values that differ from the previous block) and `files` (vercel.json
 * and the skill: 'written' or 'kept'; an existing file is kept unless
 * `overwrite`) and `templateDrift` ({kind: state} for kept files that differ from what the
 * template renders now: 'template-moved' if the template changed since
 * deploy:add last wrote the file, 'customised' if it has not, 'unknown' if the
 * deploy block records no template hash). `deploy.templateHashes` holds the
 * hashes; a write, including --overwrite, updates them. Throws, before writing
 * anything, on an app project.json doesn't declare or a provider nothing
 * registers.
 */
export function addDeploy({ provider, app, team, project, url, commitEndpoint, overwrite = false, root = ROOT, manifestPath = MANIFEST }) {
  const templateDir = TEMPLATE_DIRS[provider];
  if (!templateDir) throw new Error(`unknown deploy provider "${provider}"`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const target = manifest.apps?.[app];
  if (!target) throw new Error(`no app named "${app}" in project.json`);

  const values = withPlaceholders({ team, project, url, commitEndpoint, existing: target.deploy ?? {} });
  // Values that differ from the app's previous deploy block (none on a first
  // run): a kept file still holds the old ones.
  const previous = target.deploy;
  const changed = previous
    ? Object.fromEntries(Object.keys(values).filter((k) => previous[k] !== undefined && previous[k] !== values[k]).map((k) => [k, { from: previous[k], to: values[k] }]))
    : {};
  const placeholders = { app, ...values };
  const appDir = join(root, target.path);
  const kinds = Object.fromEntries(
    TEMPLATE_HASH_KEYS.map((kind) => [kind, { path: join(appDir, TEMPLATE_FILES[kind].path), templateFile: TEMPLATE_FILES[kind].templateFile }]),
  );
  // What each file would be now, and a hash of the template text itself (not
  // the render, so a changed team or project value is not mistaken for a
  // template change). The hash recorded in the deploy block is the one from
  // the last time deploy:add wrote that file; a kept file leaves it alone.
  const recorded = { ...(previous?.templateHashes ?? {}) };
  const files = {};
  const templateDrift = {};
  const writes = [];
  for (const [kind, { path, templateFile }] of Object.entries(kinds)) {
    const text = readFileSync(join(templateDir, templateFile), 'utf8');
    const rendered = renderTemplate(text, placeholders);
    const hash = createHash('sha256').update(text).digest('hex');
    if (existsSync(path) && !overwrite) {
      files[kind] = 'kept';
      if (readFileSync(path, 'utf8') === rendered) {
        // In step with the template as it is now (hand-synced, or never recorded): note that,
        // so a later edit is a customisation and not a moved template. The file is not written.
        recorded[kind] = hash;
      } else {
        // 'template-moved' is the actionable case (a template fix never reaches a kept file);
        // 'customised' is the file differing while the template is what it was; 'unknown' is a block with no record.
        templateDrift[kind] = recorded[kind] === undefined ? 'unknown' : recorded[kind] !== hash ? 'template-moved' : 'customised';
      }
    } else {
      files[kind] = 'written';
      recorded[kind] = hash;
      writes.push([path, rendered]);
    }
  }
  target.deploy = { provider, ...values, ...(Object.keys(recorded).length ? { templateHashes: recorded } : {}) };
  validate(manifest); // throws, before anything is written, if the result is malformed

  // Worked out before the first write too, so a smoke.yml it cannot edit
  // stops the command with nothing changed. A repository with no smoke.yml
  // (a test fixture, a product that deleted it) has no schedule to restore.
  const workflowPath = join(root, SMOKE_WORKFLOW);
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : null;
  const scheduled = workflow === null ? null : withSmokeSchedule(workflow);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(appDir, { recursive: true });
  for (const [path, rendered] of writes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
  }

  let smoke = 'absent';
  if (scheduled !== null) {
    smoke = scheduled === workflow ? 'unchanged' : 'scheduled';
    if (smoke === 'scheduled') writeFileSync(workflowPath, scheduled);
  }

  return { manifest, values, smoke, files, changed, templateDrift };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { values, smoke, files, changed, templateDrift } = addDeploy(opts);
    console.log(`Wrote project.json's deploy block for "${opts.app}".`);
    const names = Object.fromEntries(TEMPLATE_HASH_KEYS.map((kind) => [kind, TEMPLATE_FILES[kind].name]));
    const changes = Object.entries(changed).map(([k, { from, to }]) => `${k}: ${from} -> ${to}`);
    for (const [kind, state] of Object.entries(files)) {
      if (state !== 'kept') {
        console.log(`Wrote ${kind === 'skill' ? 'the ' : ''}${names[kind]}.`);
        continue;
      }
      console.log(`Kept the existing ${names[kind]} (pass --overwrite to replace it from the template).`);
      if (changes.length) console.log(`  It may be stale: ${changes.join('; ')}. Update it by hand, or re-run with --overwrite.`);
      const drift = templateDrift[kind];
      if (drift === 'template-moved') {
        console.log(`  The template for the ${names[kind]} has changed since it was written, so the kept file is behind it. Compare it with scripts/deploy/vercel/template/, or apply the template with --overwrite (which discards customisations).`);
      } else if (drift === 'unknown') {
        console.log(`  Whether the template for the ${names[kind]} has moved is unknown (project.json records no template hash). Compare it with scripts/deploy/vercel/template/, or use --overwrite.`);
      } else if (drift === 'customised') {
        console.log(`  (The ${names[kind]} differs from the template only by your customisation.)`);
      }
    }
    if (smoke === 'scheduled') console.log(`Added the every-3-hours schedule to ${SMOKE_WORKFLOW}.`);
    if (smoke === 'absent') console.log(`No ${SMOKE_WORKFLOW} here, so no scheduled smoke run was added.`);
    console.log('\nOwner steps:');
    for (const step of ownerSteps({ app: opts.app, ...values })) console.log(`- ${step}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
