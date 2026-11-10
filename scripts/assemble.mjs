// Build a product's file tree from the engine plus chosen starters.
//
// The parts are declared in place, in catalogue.json at the repository root:
// the engine (the loop, kept in step with the base for good), the starters
// (an app directory plus the files it needs outside it, copied once and then
// the product's own) and the providers (code that ships with the engine).
// This module reads that catalogue and writes a tree into an empty directory.
//
// It is a pure file-tree builder. It takes its file list from `git ls-files`
// in the source root, so only committed files can reach a product: an
// untracked `.env.production` or key file is never copied. `git ls-files` is
// the only command it runs: no network, no install, no other git. That keeps
// `npm run verify` fast enough to assemble every starter on each run.
// Creating the repository, relocking and the first commit are the caller's
// (`setup create`). It never writes anywhere but `target`, and refuses a
// target that already has anything in it.
//
// Bounded: the file list is finite, no symlink is followed (one is an error),
// a path deeper than LIMITS.depth levels under its catalogue entry or more
// than LIMITS.files files in all is an error, and a name in the catalogue's
// `ignoredNames` is never copied, tracked or not. The limits turn a surprise
// (a stray link, a generated tree committed by mistake) into a message.
//
// A product with no starter is an engine-only product: the engine, the
// generated files, `"apps": {}` in project.json and no `apps/` directory. It
// needs an engine commit, which is what project.mjs's validate() takes as the
// mark of a product (the base itself must declare its apps).
//
// CLI:
//
//     node scripts/assemble.mjs --list
//     node scripts/assemble.mjs --target <dir> --name <name> [--starter <s> ...] [--engine-commit <sha>]
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, inside, loadProject, validate } from './project.mjs';

export { ROOT };
export const CATALOGUE = join(ROOT, 'catalogue.json');

/** Walk ceilings. A product tree is a few hundred files, a few levels deep. */
export const LIMITS = { depth: 24, files: 5000 };

// Never copied, whatever the catalogue says: local secrets and per-machine
// overrides. A product starts from committed files only.
const NEVER = (name) => name === '.env' || /^\.env\..*\.?local$/.test(name) || name === 'settings.local.json';

const SECTIONS = ['engine', 'seeded', 'generated', 'base'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function fail(what) {
  throw new Error(`catalogue.json: ${what}`);
}

function pathList(value, at) {
  if (!Array.isArray(value)) fail(`${at} must be a list`);
  for (const path of value) {
    if (typeof path !== 'string' || !inside('.', path)) fail(`${at} has "${String(path)}", which is not a normal path inside the repository`);
  }
  return value;
}

/** Throws, naming the field, unless `catalogue` has the shape catalogue.json documents. */
export function validateCatalogue(catalogue) {
  if (!catalogue || typeof catalogue !== 'object') fail('is not an object');
  const names = catalogue.ignoredNames;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !n || n.includes('/'))) {
    fail('"ignoredNames" must be a list of plain file or directory names');
  }
  const homes = new Map(); // path -> where it is declared, so no path has two homes
  const claim = (path, at) => {
    if (homes.has(path)) fail(`"${path}" is declared twice (${homes.get(path)} and ${at})`);
    homes.set(path, at);
  };
  for (const section of SECTIONS) {
    const entry = catalogue[section];
    if (!entry || typeof entry.description !== 'string' || !entry.description) fail(`"${section}" needs a description`);
    for (const path of pathList(entry.paths, `${section}.paths`)) claim(path, section);
  }
  const starters = Object.entries(catalogue.starters ?? {});
  if (starters.length === 0) fail('"starters" must declare at least one starter');
  const apps = new Set();
  for (const [key, starter] of starters) {
    const at = `starters.${key}`;
    if (typeof starter.description !== 'string' || !starter.description) fail(`${at} needs a description`);
    if (typeof starter.app !== 'string' || !starter.app) fail(`${at}.app must name an entry in project.json`);
    if (apps.has(starter.app)) fail(`${at}.app "${starter.app}" is already another starter's`);
    apps.add(starter.app);
    for (const path of pathList(starter.files, `${at}.files`)) claim(path, `${at}.files`);
    pathList(starter.build, `${at}.build`);
  }
  const providers = Object.entries(catalogue.providers ?? {});
  if (providers.length === 0) fail('"providers" must declare at least one provider');
  for (const [key, provider] of providers) {
    const at = `providers.${key}`;
    if (typeof provider.description !== 'string' || !provider.description) fail(`${at} needs a description`);
    pathList([provider.path, provider.template], at);
  }
  return catalogue;
}

export function loadCatalogue(path = CATALOGUE) {
  return validateCatalogue(JSON.parse(readFileSync(path, 'utf8')));
}

/** Whether `path` is `prefix` or lies under it, both in normal repository-relative form. */
export function under(prefix, path) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

// ---------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------

/** The block of CLAUDE.md that is identical in every repository, markers included. */
export function sharedBlock(claudeMd) {
  const begin = claudeMd.indexOf('<!-- shared:begin');
  const endMarker = '<!-- shared:end -->';
  const end = claudeMd.indexOf(endMarker);
  if (begin === -1 || end === -1 || end < begin) throw new Error('CLAUDE.md has no <!-- shared:begin … shared:end --> block to carry into a product');
  return claudeMd.slice(begin, end + endMarker.length);
}

function claudeMd(ctx) {
  const rows = ctx.starters.map(
    (s) => `| \`${s.path}/\` | ${s.description} Its own rules are in \`${s.path}/CLAUDE.md\`. |`,
  );
  const built = ctx.starters.length === 0 ? 'a shared engine and no starter' : 'a shared engine and the starters listed below';
  const apps =
    ctx.starters.length === 0
      ? 'It has no apps yet: `project.json` declares none, and `npm run verify:apps` says so and runs nothing.'
      : "It learns about the apps only from `project.json`. Each app's own rules, layout and run\ncommands are in the `CLAUDE.md` inside its directory; read it before working\nthere.";
  return `# ${ctx.name}

${ctx.name} is assembled from ${built}.
Replace this paragraph with what the product is for.

The AI layer — \`.claude/\`, \`scripts/\`, \`.github/\`, \`telemetry/\` — is the
engine: the loop of verify, review, isolate, deploy, smoke and triage.
${apps}

## Layout

| Path | Holds |
| --- | --- |
${rows.map((row) => `${row}\n`).join('')}| \`project.json\` | The one place the AI layer learns about the apps: paths, toolchains, build inputs. Read through \`scripts/project.mjs\`. |
| \`docs/\` | \`sops.md\`, how agent work is run; \`data-governance.md\`, a stub to rewrite before anything real is deployed. |

${sharedBlock(ctx.baseClaudeMd)}
`;
}

function readme(ctx) {
  return `# ${ctx.name}

${ctx.starters.length === 0 ? 'Assembled from the engine alone, with no starter.' : `Assembled from the starters ${ctx.starters.map((s) => `\`${s.key}\``).join(', ')}.`} Rewrite this README around the
product.

\`npm run bootstrap\` installs everything; \`npm run verify\` is the contract.
Read \`CLAUDE.md\` first.
`;
}

const DATA_GOVERNANCE = `# Data governance

A stub. Nothing here serves, stores or exposes data yet.

Rewrite this page before anything that serves, stores or exposes data ships:
what is exposed, to whom, why that is deliberate, and what would change it.

## What CI holds, and what voids that

The engine ships workflows that read repository secrets. A new product has
none set; the owner sets each with \`gh secret set\`, and until then the
workflows that read it have nothing to read.

| Secret | Read by |
| --- | --- |
| \`CLAUDE_CODE_OAUTH_TOKEN\` | \`.github/workflows/claude-code-review.yml\`, \`claude.yml\` |
| \`GRAFANA_CLOUD_OTLP_ENDPOINT\`, \`GRAFANA_CLOUD_OTLP_AUTH\` | the same two workflows |
| \`VERCEL_TOKEN\` | \`.github/workflows/preview-prune.yml\` |
| \`TELEGRAM_BOT_TOKEN\`, \`TELEGRAM_CHAT_ID\` | \`.github/workflows/telegram-notify.yml\` |

The review jobs check out a pull request and run a script from that checkout
while a credential is live, so a pull request can run its own code with it.
Two things bound that: the trigger is \`pull_request\`, not
\`pull_request_target\`, so a fork gets no secrets; and one person has write
access, so that code is the owner's own, run with the owner's own credential.
The second holds only while it is true: it is a fact about membership, not
something in the configuration.

**The trigger that voids it: a second person gets write access once any of
these secrets is set.** Before that, move branch-code steps out of the
credentialed jobs or pass the secrets only to the action's own step, and
rewrite this section.
`;

/**
 * The product's root package.json: the base's, under the product's name. With
 * no apps there is nothing for `workspaces` to find, and npm fails ("No
 * workspaces found!") on any script that runs `--workspaces`, so both go.
 */
function packageJson(ctx) {
  const manifest = JSON.parse(readFileSync(join(ctx.root, 'package.json'), 'utf8'));
  const withApps = Object.keys(ctx.project.apps).length > 0;
  const result = {};
  // Key order is the base's.
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'name') result.name = ctx.name;
    else if (key === 'workspaces') {
      if (withApps) result.workspaces = value;
    } else if (key === 'scripts' && !withApps) {
      result.scripts = Object.fromEntries(Object.entries(value).filter(([, command]) => !String(command).includes('--workspaces')));
    } else result[key] = value;
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

// Ecosystems a product can have a dependabot.yml entry for. github-actions and
// npm every product has (the engine's workflows; the generated root
// package.json), uv only with a Python app.
const DEPENDABOT_ECOSYSTEMS = ['github-actions', 'npm', 'uv'];

/**
 * The base's .github/dependabot.yml cut at its top-level `updates:` list into
 * `{ header, entries }`: `header` the lines up to and including `updates:`,
 * `entries` one `{ ecosystem, lines }` per `- package-ecosystem:` item with the
 * comments that sit inside it. The only YAML parser among the dependencies is a test-only one (`yaml`); this stays dependency-free:
 * the file is split by indentation and anything this does not understand
 * throws, so a shape change in the base's file cannot be silently dropped from
 * a product's.
 */
export function splitDependabot(source) {
  if (source.includes('\t')) throw new Error('assemble: .github/dependabot.yml has a tab; cannot split it');
  const lines = source.split('\n');
  const start = lines.indexOf('updates:');
  if (start === -1 || lines.indexOf('updates:', start + 1) !== -1) {
    throw new Error('assemble: .github/dependabot.yml must have exactly one top-level "updates:" line; cannot split it');
  }
  const header = lines.slice(0, start + 1);
  for (const line of header) {
    if (!/^(\s*#.*|\s*|version: 2|updates:)$/.test(line)) {
      throw new Error(`assemble: .github/dependabot.yml has "${line}" before "updates:", which assemble.mjs does not understand`);
    }
  }
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {2}- package-ecosystem: (\S+)$/.exec(line);
    const last = entries[entries.length - 1];
    if (item) entries.push({ ecosystem: item[1], lines: [line] });
    else if (/^\s*$/.test(line)) last?.lines.push(line);
    else if (/^\s*#/.test(line) && !line.startsWith('    ')) {
      // Which entry it describes cannot be told from its position: dropping it
      // or attaching it to the previous entry would be a guess.
      throw new Error(
        `assemble: .github/dependabot.yml has "${line}", a comment ${last ? 'between entries' : 'before the first entry'}; indent it inside the entry it describes`,
      );
    } else if (line.startsWith('    ')) {
      if (!last) throw new Error(`assemble: .github/dependabot.yml has "${line}" before the first "- package-ecosystem:" entry; cannot split it`);
      last.lines.push(line);
    } else {
      throw new Error(`assemble: .github/dependabot.yml has "${line}", which assemble.mjs does not understand; entries are "  - package-ecosystem: <name>" items`);
    }
  }
  if (entries.length === 0) throw new Error('assemble: .github/dependabot.yml has no "- package-ecosystem:" entries');
  for (const { ecosystem } of entries) {
    if (!DEPENDABOT_ECOSYSTEMS.includes(ecosystem)) {
      throw new Error(`assemble: .github/dependabot.yml has an entry for "${ecosystem}", and assemble.mjs does not know whether a product has it (known: ${DEPENDABOT_ECOSYSTEMS.join(', ')})`);
    }
  }
  return { header, entries };
}

/**
 * A product's .github/dependabot.yml: the base's, less the entries of
 * ecosystems the product lacks. The base's file stays the one place the
 * configuration is written. Throws when the base's file lacks an entry the
 * product needs.
 */
export function dependabotYml(source, { python }) {
  const { header, entries } = splitDependabot(source);
  const wanted = DEPENDABOT_ECOSYSTEMS.filter((ecosystem) => ecosystem !== 'uv' || python);
  for (const ecosystem of wanted) {
    if (!entries.some((entry) => entry.ecosystem === ecosystem)) throw new Error(`assemble: .github/dependabot.yml has no "${ecosystem}" entry for a product to keep`);
  }
  const kept = entries.filter((entry) => wanted.includes(entry.ecosystem)).map((entry) => entry.lines.join('\n').trimEnd());
  return `${header.join('\n')}\n${kept.join('\n\n')}\n`;
}

function dependabot(ctx) {
  const python = Object.values(ctx.project.apps).some((app) => app.toolchain === 'python');
  return dependabotYml(readFileSync(join(ctx.root, '.github/dependabot.yml'), 'utf8'), { python });
}

/** Every generated file's path, to the function that writes it. A catalogue path with no entry here is an error. */
export const GENERATORS = {
  '.github/dependabot.yml': dependabot,
  'CLAUDE.md': claudeMd,
  'README.md': readme,
  'docs/data-governance.md': () => DATA_GOVERNANCE,
  'package.json': packageJson,
  'project.json': (ctx) => `${JSON.stringify(ctx.project, null, 2)}\n`,
};

/** Copied files whose content carries the project's name, which is the product's own. */
const RENAMED = {
  'package-lock.json': (text, ctx) => {
    const lock = JSON.parse(text);
    lock.name = ctx.name;
    if (lock.packages?.['']) lock.packages[''].name = ctx.name;
    return `${JSON.stringify(lock, null, 2)}\n`;
  },
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * The committed files of the checkout at `root`, as repository-relative paths.
 * `GIT_CEILING_DIRECTORIES` stops git finding a repository above `root`, so a
 * source tree that is not itself a checkout fails instead of listing some
 * other repository's files.
 */
export function trackedFiles(root) {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...environment } = process.env;
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE would override `cwd` and list
    // some other repository, so they are not passed on.
    env: { ...environment, GIT_CEILING_DIRECTORIES: dirname(resolve(root)) },
  });
  if (result.error || result.status !== 0) {
    const why = (result.error?.message ?? result.stderr ?? '').trim();
    throw new Error(`assemble: ${root} is not a git checkout (git ls-files failed: ${why}); a product is built from committed files`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

/**
 * Every committed file under `rel` (or `rel` itself), sorted, without what
 * `skip` or the catalogue's ignored names exclude. A committed file that is
 * missing from the working tree is an error.
 */
function walk(root, rel, { tracked, skip, limits, count }) {
  const found = tracked.filter((path) => under(rel, path));
  if (found.length === 0) throw new Error(`assemble: "${rel}" does not exist, or has no committed files, in ${root}`);
  const out = [];
  for (const path of found.sort()) {
    const parts = path.split('/');
    const levels = path === rel ? 0 : path.slice(rel.length + 1).split('/').length - 1;
    if (levels > limits.depth) throw new Error(`assemble: "${path}" is nested deeper than ${limits.depth} levels under "${rel}"`);
    if (parts.some((part) => NEVER(part) || skip.names.has(part))) continue;
    if (skip.paths.some((p) => under(p, path))) continue;
    let info;
    try {
      info = lstatSync(join(root, ...parts));
    } catch (error) {
      // A committed file that is gone from disk would leave a hole in the
      // product with no message, so it stops the build.
      if (error.code === 'ENOENT') throw new Error(`assemble: "${path}" is tracked but missing from the working tree in ${root}`);
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`assemble: "${path}" is a symbolic link; nothing is followed`);
    if (!info.isFile()) throw new Error(`assemble: "${path}" is neither a file nor a symbolic link`);
    if (++count.n > limits.files) throw new Error(`assemble: more than ${limits.files} files; something that should be skipped is not`);
    out.push(path);
  }
  return out;
}

/**
 * What a product of `starters` holds, without writing anything:
 * `{ entries: [{ to, from } | { to, content }], project }`, entries sorted by
 * `to`. `engineCommit`, when given, is recorded as `engine.commit` in the
 * product's project.json; it is required when `starters` is empty. Throws on an unknown starter, a name nothing can use,
 * an engine commit that is not a full SHA, a catalogue path
 * that does not exist, two sources for one file, or an app that reads or
 * smoke-tests something the product would not have.
 */
export function plan({ root = ROOT, catalogue = loadCatalogue(join(root, 'catalogue.json')), name, starters, engineCommit, limits = LIMITS }) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`assemble: name "${String(name)}" must be lowercase letters, digits, "." "_" or "-"`);
  // No starter is allowed: an engine-only product. It is marked by its engine
  // commit, so validate() below refuses it without one (an empty `apps` is
  // only a product's).
  if (!Array.isArray(starters)) throw new Error('assemble: starters must be a list (empty for an engine-only product)');
  if (new Set(starters).size !== starters.length) throw new Error('assemble: a starter is chosen twice');
  for (const key of starters) {
    if (!catalogue.starters[key]) throw new Error(`assemble: no starter named "${key}" (have: ${Object.keys(catalogue.starters).join(', ')})`);
  }

  const base = loadProject(join(root, 'project.json'));
  const chosen = starters.map((key) => {
    const starter = catalogue.starters[key];
    const app = base.apps[starter.app];
    if (!app) throw new Error(`assemble: starter "${key}" names app "${starter.app}", which project.json does not declare`);
    return { key, ...starter, path: app.path, entry: app };
  });

  // The product's project.json: the base's own app entries, only the chosen
  // ones, with the base's deployment left behind — a product deploys through
  // `deploy:add`, to its own project.
  const comment = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).$comment;
  const project = {
    ...(comment ? { $comment: comment } : {}),
    name,
    // The base commit the engine was copied from, when the caller knows it
    // (`setup create` does). project.mjs's validate() holds it to a full SHA.
    ...(engineCommit === undefined ? {} : { engine: { commit: engineCommit } }),
    apps: Object.fromEntries(
      chosen.map(({ app, entry }) => {
        const { deploy: _deploy, ...rest } = entry;
        // A build input that is the base's own file (the web starter reads the
        // root index.html, which only the base has) names nothing in a product:
        // the build skips it there, and a read of nothing is not a read.
        const reads = entry.reads.filter((path) => !catalogue.base.paths.some((own) => under(own, path)));
        return [app, { ...rest, reads }];
      }),
    ),
  };
  validate(project);

  const elsewhere = [...catalogue.seeded.paths, ...catalogue.generated.paths, ...catalogue.base.paths];
  const ctx = {
    root,
    name,
    project,
    starters: chosen,
    baseClaudeMd: existsSync(join(root, 'CLAUDE.md')) ? readFileSync(join(root, 'CLAUDE.md'), 'utf8') : '',
  };
  const names = new Set(catalogue.ignoredNames);
  const entries = new Map();
  const add = (entry, source) => {
    if (entries.has(entry.to)) throw new Error(`assemble: "${entry.to}" would be written twice (${entries.get(entry.to).source} and ${source})`);
    entries.set(entry.to, { ...entry, source });
  };
  const copy = (files, source) => {
    for (const path of files) {
      const rewrite = RENAMED[path];
      if (rewrite) add({ to: path, content: rewrite(readFileSync(join(root, path), 'utf8'), ctx) }, source);
      else add({ to: path, from: path }, source);
    }
  };
  const count = { n: 0 };
  const tracked = trackedFiles(root);

  for (const path of catalogue.engine.paths) {
    copy(walk(root, path, { tracked, skip: { names, paths: elsewhere }, limits, count }), 'engine');
  }
  for (const path of catalogue.seeded.paths) copy(walk(root, path, { tracked, skip: { names, paths: [] }, limits, count }), 'seeded');
  for (const starter of chosen) {
    for (const path of [starter.path, ...starter.files]) {
      copy(walk(root, path, { tracked, skip: { names, paths: starter.build }, limits, count }), `starter ${starter.key}`);
    }
  }
  for (const path of catalogue.generated.paths) {
    const generate = GENERATORS[path];
    if (!generate) throw new Error(`assemble: the catalogue generates "${path}" but assemble.mjs has no generator for it`);
    add({ to: path, content: generate(ctx) }, 'generated');
  }

  // An app that reads, or smoke-tests, a path the product lacks would build
  // from nothing. Globs in `ignores` are not paths and are not checked.
  const has = (path) => [...entries.keys()].some((to) => under(path, to));
  for (const { key, entry, app } of chosen) {
    for (const path of [...project.apps[app].reads, ...(entry.smoke ? [entry.smoke] : [])]) {
      if (!has(path)) throw new Error(`assemble: app "${app}" (starter ${key}) reads "${path}", which the product would not have`);
    }
  }

  return { entries: [...entries.values()].sort((a, b) => (a.to < b.to ? -1 : 1)), project };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** `path` with its nearest existing ancestor resolved through any symbolic links. */
function resolvedPath(path) {
  const rest = [];
  let here = resolve(path);
  // Ends: each pass moves one level up, and the filesystem root exists.
  for (;;) {
    try {
      return join(realpathSync(here), ...rest);
    } catch (error) {
      const parent = dirname(here);
      if (error.code !== 'ENOENT' || parent === here) throw error;
      rest.unshift(basename(here));
      here = parent;
    }
  }
}

/** Throws unless `target` is absent or an empty directory outside `root`. */
export function checkTarget(target, root) {
  const rel = relative(realpathSync(resolve(root)), resolvedPath(target));
  // `..x` is a sibling name inside the root; only `..` itself, or `..` as a
  // whole leading segment, climbs out.
  const climbsOut = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!climbsOut) throw new Error(`assemble: target ${target} is inside the source tree ${root}`);
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) throw new Error(`assemble: target ${target} exists and is not a directory`);
  if (readdirSync(target).length > 0) throw new Error(`assemble: target ${target} is not empty`);
}

/** Writes planned `entries` under `where`, file entries copied from `root` with their mode, generated ones from their content. */
export function writeEntries(root, where, entries) {
  mkdirSync(where, { recursive: true });
  for (const entry of entries) {
    const to = join(where, ...entry.to.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    if (entry.from !== undefined) {
      const from = join(root, ...entry.from.split('/'));
      writeFileSync(to, readFileSync(from));
      chmodSync(to, statSync(from).mode & 0o777);
    } else writeFileSync(to, entry.content);
  }
}

/**
 * Builds a product into `target`: the engine, the chosen `starters`, and the
 * product's own `project.json`. Plans everything first, so a refusal leaves
 * `target` untouched. Returns `{ target, files, project }`, `files` sorted.
 */
export function assemble({ target, ...rest }) {
  if (typeof target !== 'string' || !target) throw new Error('assemble: a target directory is required');
  const root = rest.root ?? ROOT;
  const where = resolve(target);
  checkTarget(where, root);
  const { entries, project } = plan({ ...rest, root });
  writeEntries(root, where, entries);
  return { target: where, files: entries.map((e) => e.to), project };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { starters: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--list') opts.list = true;
    else if (flag === '--target' || flag === '--name' || flag === '--starter' || flag === '--engine-commit') {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--starter') opts.starters.push(value);
      else if (flag === '--engine-commit') opts.engineCommit = value;
      else opts[flag.slice(2)] = value;
    } else {
      throw new Error(
        `usage: assemble.mjs --list | --target <dir> --name <name> [--starter <s> ...] [--engine-commit <sha>]: unknown argument "${flag}"`,
      );
    }
  }
  return opts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.list) {
      const catalogue = loadCatalogue();
      for (const [key, starter] of Object.entries(catalogue.starters)) console.log(`starter  ${key}: ${starter.description}`);
      for (const [key, provider] of Object.entries(catalogue.providers)) console.log(`provider ${key}: ${provider.description}`);
    } else {
      const { target, files } = assemble({ target: opts.target, name: opts.name, starters: opts.starters, engineCommit: opts.engineCommit });
      console.log(`Assembled ${files.length} files into ${target.split(sep).join('/')}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
