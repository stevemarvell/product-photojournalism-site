// Labels as data, not something each repository re-creates by hand.
//
// Every repository built from boris ended up with its own slightly different
// idea of what `critical` or `aia1` means, because the only copy of a label's
// colour and description lived in whichever repository's settings UI someone
// typed it into last. `labels.json` at the repository root is now the single
// source of truth; this script makes a repository's live labels match it.
//
// CLI:
//
//     node scripts/labels.mjs [--repo owner/name] [--dry-run]
//
// Without `--repo`, `gh` resolves the repository from the current directory
// the way every other `gh` invocation here does. `--dry-run` prints what
// would change without writing any label.
//
// Everything goes through `gh api` (REST), not `gh label`: the `gh label`
// subcommands are GraphQL, which Claude Code cloud sessions refuse (#225).
//
// This never deletes a label. A name in a repository's label set that is not
// in the manifest is left alone — removing it is a judgement call about that
// repository's own issues and pull requests, not something synced data
// should do unattended.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = join(dirname(dirname(fileURLToPath(import.meta.url))), 'labels.json');

const COLOR = /^[0-9a-f]{6}$/i;

/** Throws, naming the problem, unless `manifest` is the shape `labels.json` documents. */
export function validate(manifest) {
  const fail = (what) => {
    throw new Error(`labels.json: ${what}`);
  };
  if (!Array.isArray(manifest) || manifest.length === 0) fail('must be a non-empty array');
  const seen = new Set();
  for (const [i, label] of manifest.entries()) {
    const at = `[${i}]`;
    if (!label || typeof label !== 'object') fail(`${at} must be an object`);
    if (typeof label.name !== 'string' || !label.name) fail(`${at}.name must be a non-empty string`);
    if (seen.has(label.name)) fail(`"${label.name}" is listed more than once`);
    seen.add(label.name);
    if (typeof label.color !== 'string' || !COLOR.test(label.color)) fail(`"${label.name}".color must be a 6-digit hex string`);
    if (typeof label.description !== 'string') fail(`"${label.name}".description must be a string`);
  }
  return manifest;
}

/** The manifest, read from disk and validated. */
export function loadManifest(path = MANIFEST) {
  return validate(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * The labels to create or update, given the manifest and a repository's
 * existing labels (`name`, `color`, `description` from the REST labels listing).
 *
 * A label absent from `existing` is a create. One present with a different
 * colour or description is an update. One already matching is left out —
 * `plan` never reports a label as changing when nothing would. Never returns
 * anything for a name that is in `existing` but not in the manifest: this
 * never deletes.
 */
export function plan(manifest, existing) {
  const current = new Map(existing.map((label) => [label.name, label]));
  const actions = [];
  for (const label of manifest) {
    const have = current.get(label.name);
    if (!have) {
      actions.push({ ...label, action: 'create' });
    } else if (have.color.toLowerCase() !== label.color.toLowerCase() || (have.description ?? '') !== label.description) {
      actions.push({ ...label, action: 'update' });
    }
  }
  return actions;
}

/** Runs `gh` with `args`, resolving to its exit status, stdout and stderr. Never rejects. */
export function gh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** What a failed `run` call says went wrong: stderr, falling back to stdout when gh left stderr empty. */
function reason({ stdout, stderr }) {
  return (stderr?.trim() || stdout?.trim() || '').trim();
}

/** Labels per REST page; GitHub's maximum. */
export const LABEL_PAGE_SIZE = 100;

/** Pages of labels read before giving up (SOP 1: a declared ceiling, reported when hit): 500 labels. */
export const MAX_LABEL_PAGES = 5;

/** The REST path of `repo`'s labels, `owner/name`, or gh's own `{owner}/{repo}` placeholders (the cwd's remote) when omitted. */
function labelsRoute(repo) {
  return `repos/${repo ?? '{owner}/{repo}'}/labels`;
}

/**
 * The live labels of a repository, via the REST labels listing. Fails rather
 * than planning from a partial list when it runs out of pages: planning a
 * "create" for a label that exists but was never read would fail on every
 * run, and one for a changed label would be wrong.
 */
export async function listLabels(run, repo, maxPages = MAX_LABEL_PAGES) {
  const labels = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await run(['api', `${labelsRoute(repo)}?per_page=${LABEL_PAGE_SIZE}&page=${page}`]);
    if (result.status !== 0) throw new Error(`gh api labels failed: ${reason(result)}`);
    const batch = JSON.parse(result.stdout);
    labels.push(...batch.map(({ name, color, description }) => ({ name, color, description: description ?? '' })));
    if (batch.length < LABEL_PAGE_SIZE) return labels;
  }
  throw new Error(`gh api labels returned ${maxPages * LABEL_PAGE_SIZE} labels and more pages remain; raise MAX_LABEL_PAGES`);
}

/** The `gh api` arguments that make one planned change: POST to create, PATCH to update. */
export function writeArgs(label, repo) {
  const fields = ['-f', `color=${label.color}`, '-f', `description=${label.description}`];
  return label.action === 'create'
    ? ['api', labelsRoute(repo), '-X', 'POST', '-f', `name=${label.name}`, ...fields]
    : ['api', `${labelsRoute(repo)}/${encodeURIComponent(label.name)}`, '-X', 'PATCH', ...fields];
}

/**
 * Bring a repository's labels to match the manifest. Returns the plan it
 * applied (or would apply, under `dryRun`).
 */
export async function apply({ run = gh, manifest, repo, dryRun = false, log = console.log }) {
  const existing = await listLabels(run, repo);
  const actions = plan(manifest, existing);
  for (const label of actions) {
    log(`${dryRun ? 'would ' : ''}${label.action} ${label.name} (#${label.color})`);
    if (dryRun) continue;
    const result = await run(writeArgs(label, repo));
    if (result.status !== 0) throw new Error(`gh api ${label.action} label ${label.name} failed: ${reason(result)}`);
  }
  if (actions.length === 0) log('every label already matches labels.json');
  return actions;
}

export async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const repoFlag = argv.indexOf('--repo');
  const repo = repoFlag === -1 ? undefined : argv[repoFlag + 1];
  // A missing value, or one that is itself a flag (`--repo --dry-run`, or
  // `--repo` last), is not a repository name; treat it as the usage error
  // rather than passing "--dry-run" on as a repository.
  if (repoFlag !== -1 && (!repo || repo.startsWith('--'))) {
    throw new Error('usage: labels.mjs [--repo owner/name] [--dry-run]');
  }
  const manifest = loadManifest();
  await apply({ manifest, repo, dryRun });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
