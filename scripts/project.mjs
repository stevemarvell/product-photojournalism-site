// The AI layer's only view of the application.
//
// Everything under .claude/, scripts/ and .github/ that needs to know what
// the application is — where its apps live, what toolchain each uses, what a
// build reads, whether and where it deploys, where it answers and how to
// smoke-test it — asks
// this module, which reads project.json at the repository root. Swapping in
// another application means editing apps/ and project.json; nothing here
// names an app.
//
// The manifest is validated on load, so a typo fails the first hook or script
// that reads it, loudly, rather than turning into a build that silently never
// happens. A field is added when something reads it, not before.
//
// Deployment is an add-on, not the default: an app with no `deploy` block is
// "not deployed" — `verify` still runs it, and everything deploy-related
// (smoke, preview-prune, the ignore step) skips it. `npm run deploy:add`
// (scripts/deploy/add.mjs) is how a `deploy` block gets added.
//
// CLI, for workflows and shells:
//
//     node scripts/project.mjs apps [toolchain]   # app paths, one per line
//     node scripts/project.mjs toolchains         # node=true / python=false / e2e=true, for $GITHUB_OUTPUT
//     node scripts/project.mjs --has-deploy       # true/false; exit 0 iff true
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MANIFEST = join(ROOT, 'project.json');

// The AI layer's own code, which `verify` tests and the stop hook therefore
// watches. Declared here rather than in the manifest: it is this layer's
// footprint, not the application's.
export const HARNESS_CODE = ['scripts', '.claude/hooks', '.claude/statusline.mjs', 'project.json', 'catalogue.json'];

const TOOLCHAINS = new Set(['python', 'node']);

// Every deploy provider this layer knows, and the ignore script each one's
// build-skip decision lives behind. scripts/deploy/index.mjs is the registry
// that maps a provider name to its actual functions; this module only needs
// to know a provider is real and which ignore script a change to it should
// rebuild for — not how any of it works.
const PROVIDER_IGNORE_SCRIPTS = { vercel: 'scripts/deploy/vercel/vercel-ignore.mjs' };
const PROVIDERS = new Set(Object.keys(PROVIDER_IGNORE_SCRIPTS));

/**
 * Whether `child` is strictly inside `parent`, both repository-relative. A
 * string prefix is not enough — `apps/api/../../etc/x` starts with
 * `apps/api/` — so both are normalised and `child` must be
 * spelled in normal form, with no `..` left once it is.
 */
export function inside(parent, child) {
  if (typeof child !== 'string' || posix.isAbsolute(child) || posix.normalize(child) !== child) return false;
  const rel = posix.relative(posix.normalize(parent), child);
  return rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel);
}

/** A repository-relative path in normal form that does not climb out of the repository. */
function isContainedPath(path) {
  return typeof path === 'string' && path !== '' && inside('.', path);
}

/** The files deploy:add records a template hash for: the only keys `deploy.templateHashes` may hold. */
export const TEMPLATE_HASH_KEYS = ['vercelJson', 'skill'];

/** Throws, naming the field, unless `project` has the shape project.json documents. */
export function validate(project) {
  const fail = (what) => {
    throw new Error(`project.json: ${what}`);
  };
  if (!project || typeof project !== 'object') fail('is not an object');
  if (typeof project.name !== 'string' || !project.name) fail('"name" must be a non-empty string');
  // Which base commit a product was assembled from (`setup create` writes it,
  // the sync-ai-layer skill moves it, `setup check` measures from it). Optional:
  // the base itself is the engine and has no commit to record.
  if (project.engine !== undefined) {
    const engine = project.engine;
    if (!engine || typeof engine !== 'object' || Array.isArray(engine)) fail('"engine" must be an object');
    if (typeof engine.commit !== 'string' || !/^[0-9a-f]{40}$/.test(engine.commit)) {
      fail('"engine.commit" must be a full 40-character lowercase hex commit SHA');
    }
  }
  // `apps` must be an object. An empty one is an engine-only product: the
  // engine and no application, what `setup create` makes without a --starter.
  // Only a product says so, by carrying engine.commit; the base never does, so
  // its own project.json is still held to declaring its apps.
  if (!project.apps || typeof project.apps !== 'object' || Array.isArray(project.apps)) fail('"apps" must be an object');
  const apps = Object.entries(project.apps);
  if (apps.length === 0 && project.engine === undefined) {
    fail('"apps" must declare at least one app (only a product, which records "engine.commit", may declare none)');
  }
  for (const [name, app] of apps) {
    const at = `apps.${name}`;
    if (!isContainedPath(app.path)) fail(`${at}.path must be a relative path inside the repository`);
    if (!TOOLCHAINS.has(app.toolchain)) fail(`${at}.toolchain must be one of ${[...TOOLCHAINS].join(', ')}`);
    if (!Array.isArray(app.reads) || app.reads.length === 0) fail(`${at}.reads must list at least one path`);
    if (app.ignores !== undefined && !Array.isArray(app.ignores)) fail(`${at}.ignores must be a list`);
    if (app.verify !== undefined && !(Array.isArray(app.verify) && app.verify.every((c) => typeof c === 'string' && c.trim()))) {
      fail(`${at}.verify must be a list of commands`);
    }
    // An app's `deploy` block is optional: without one, the app is "not
    // deployed", and `verify` is the only thing that still runs it. With one,
    // it has to say where it answers and which endpoint reports the commit it
    // was built from — smoke's freshness gate is what tells a deployment that
    // happened from one that silently did not.
    if (app.deploy !== undefined) {
      const deploy = app.deploy;
      if (!deploy || typeof deploy !== 'object') fail(`${at}.deploy must be an object`);
      if (!PROVIDERS.has(deploy.provider)) fail(`${at}.deploy.provider must be one of ${[...PROVIDERS].join(', ')}`);
      if (typeof deploy.team !== 'string' || !deploy.team) fail(`${at}.deploy.team must be a non-empty string`);
      if (typeof deploy.project !== 'string' || !deploy.project) fail(`${at}.deploy.project must be a non-empty string`);
      if (typeof deploy.url !== 'string' || !/^https:\/\/[^/]+$/.test(deploy.url)) {
        fail(`${at}.deploy.url must be an https origin with no path`);
      }
      if (typeof deploy.commitEndpoint !== 'string' || !deploy.commitEndpoint.startsWith('/')) {
        fail(`${at}.deploy.commitEndpoint must be a path starting with /`);
      }
      // Optional: sha256 of the template output deploy:add last wrote, per file.
      if (deploy.templateHashes !== undefined) {
        const hashes = deploy.templateHashes;
        if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) fail(`${at}.deploy.templateHashes must be an object`);
        for (const [kind, hash] of Object.entries(hashes)) {
          if (!TEMPLATE_HASH_KEYS.includes(kind)) {
            fail(`${at}.deploy.templateHashes.${kind} is not a known key (expected ${TEMPLATE_HASH_KEYS.join(' or ')})`);
          }
          if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) fail(`${at}.deploy.templateHashes.${kind} must be a sha256 hex string`);
        }
      }
    }
    if (app.smoke !== undefined && !inside(app.path, app.smoke)) {
      fail(`${at}.smoke must be a script inside ${app.path}`);
    }
  }
  return project;
}

export function loadProject(path = MANIFEST) {
  return validate(JSON.parse(readFileSync(path, 'utf8')));
}

/** The apps, as [name, app] pairs, optionally only one toolchain's. */
export function apps(project, toolchain) {
  return Object.entries(project.apps).filter(([, app]) => !toolchain || app.toolchain === toolchain);
}

/** The apps that are deployed: those with a `deploy` block, whatever the provider. */
export function deployed(project) {
  return apps(project).filter(([, app]) => app.deploy);
}

/** Whether any app is deployed. What `--has-deploy` answers. */
export function hasDeploy(project) {
  return deployed(project).length > 0;
}

/**
 * Whether any app's `verify` list runs end-to-end tests, which is what needs a
 * browser installed: `e2e` or `playwright` as a token, bounded by a
 * non-alphanumeric character or the string's edge. `_` counts as a boundary
 * (`test_e2e`), so `fe2esque` does not match but `tests/test_e2e.py` does.
 */
export function hasE2e(project) {
  return apps(project).some(([, app]) => (app.verify ?? []).some((command) => /(?<![a-z0-9])(e2e|playwright)(?![a-z0-9])/i.test(command)));
}

/** The app whose directory holds `relativePath`, or null. The deepest path wins. */
export function appFor(project, relativePath) {
  const path = relativePath.replace(/\\/g, '/');
  let best = null;
  for (const [name, app] of apps(project)) {
    if ((path === app.path || path.startsWith(`${app.path}/`)) && (!best || app.path.length > best[1].path.length)) {
      best = [name, app];
    }
  }
  return best;
}

/**
 * Git pathspecs for what a build of `name` reads. The manifest and this
 * module are always included: a change to either can change what a build
 * decides, so it rebuilds everything rather than guess. A deployed app's own
 * provider ignore script is included too — not for an undeployed app, which
 * has no ignore step to be wrong about.
 */
export function buildPathspecs(project, name) {
  const app = project.apps[name];
  if (!app) return null;
  const ignoreScript = app.deploy ? PROVIDER_IGNORE_SCRIPTS[app.deploy.provider] : undefined;
  return [
    ...app.reads,
    'project.json',
    'scripts/project.mjs',
    ...(ignoreScript ? [ignoreScript] : []),
    ...(app.ignores ?? []).map((path) => (path.includes('*') ? `:(exclude,glob)${path}` : `:(exclude)${path}`)),
  ];
}

/** Every path `verify` covers: each app's inputs and the AI layer's own code. */
export function verifiedPaths(project) {
  const paths = new Set(HARNESS_CODE);
  for (const [, app] of apps(project)) {
    paths.add(app.path);
    for (const read of app.reads) paths.add(read);
  }
  return [...paths];
}

/** The CLI's answer as lines. Only subcommands something calls are here. */
export function cli([command, ...args], project = loadProject()) {
  if (command === 'apps') return apps(project, args[0]).map(([, app]) => app.path);
  // One `<toolchain>=<true|false>` line per toolchain, whether any app uses it,
  // then `e2e=<true|false>`: whether any app's verify runs an e2e command.
  // Appended as-is to $GITHUB_OUTPUT, they are what verify.yml's later steps
  // gate on, so a product with no browser tests never installs a browser.
  if (command === 'toolchains') {
    return [...[...TOOLCHAINS].sort().map((t) => `${t}=${apps(project, t).length > 0}`), `e2e=${hasE2e(project)}`];
  }
  throw new Error('usage: project.mjs apps [toolchain] | toolchains | --has-deploy');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  // Its own path, ahead of cli(): a workflow step branches on this with
  // `if node scripts/project.mjs --has-deploy; then …`, so the exit code is
  // the contract, not just the printed word.
  if (argv[0] === '--has-deploy') {
    const has = hasDeploy(loadProject());
    console.log(has ? 'true' : 'false');
    process.exit(has ? 0 : 1);
  }
  try {
    process.stdout.write(cli(argv).join('\n') + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
