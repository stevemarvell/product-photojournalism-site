// Nothing a template has to stay neutral about should be hardcoded anywhere
// in it: not this repository's own name, not an application it once ran, not
// a platform it once deployed to. Each leaves a trail wherever it leaks into
// a file that should have named nothing, or should have read project.json
// instead. This test is that trail's detector, run as `git grep` sees the
// repository rather than as a list anyone has to remember to update by hand.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, loadProject } from '../project.mjs';

interface Allowed {
  file: string;
  pattern: RegExp;
  because: string;
  /**
   * The line exists only in boris itself: the file is not part of a product
   * (it is generated, or listed in catalogue.json's `base`), or the line is
   * the base's own and the product's copy says something else. Such an entry
   * is neither applied nor required to match in a product.
   */
  base?: true;
}

/**
 * This test ships to every product with the rest of scripts/test/, and
 * catalogue.json does not (it is listed in the catalogue's own `base`), so its
 * presence is how a checkout tells boris from a product built from it. In a
 * product the engine must stay as neutral as it does here, and every entry
 * not marked `base` is a line the engine itself carries, so those still have
 * to match a real hit. The entries marked `base` describe boris's own files.
 */
const IN_BASE = existsSync(join(ROOT, 'catalogue.json'));

/**
 * Every line this repository is allowed to still say one of NAMES on, and
 * why. Matched by file and the line's own content, never by line number — a
 * reflow elsewhere in the file must not widen what an entry hides. Keep this
 * to exactly the lines that need it: a glob or a whole-file entry here is
 * the same shape of inert control this test exists to catch everywhere else.
 */
const ALLOW: Allowed[] = [
  // The adoption ladder preserves the source document's own wording,
  // including its byline — CLAUDE.md says so.
  { file: 'docs/adoption.md', pattern: /Boris Cherny/, because: "the source document's own byline", base: true },

  // Shared, byte-identical across every repository built from this one.
  // Another agent owns .claude/skills/sync-ai-layer/; it documents the
  // convention that naming boris as the master copy is the same everywhere.
  {
    file: '.claude/skills/sync-ai-layer/SKILL.md',
    pattern: /boris/i,
    because: 'owned by sync-ai-layer; documents naming boris as the master, which is the same everywhere',
  },

  // This repository's own name, and its relationship to repositories built
  // from it — "naming boris as the master is fine" is sync-ai-layer's own
  // rule, applied here in CLAUDE.md and README.md.
  { file: 'CLAUDE.md', pattern: /^# boris$/, because: "this repository's own name", base: true },
  { file: 'CLAUDE.md', pattern: /Boris Cherny/, because: "the adoption ladder's author, named in this file's intro", base: true },
  { file: 'CLAUDE.md', pattern: /boris is also the master copy/, because: 'this repository is the master copy; stated once', base: true },
  { file: 'CLAUDE.md', pattern: /from boris\. Edit them in boris and sync/, because: 'syncing from this repository, named as itself' },
  { file: 'CLAUDE.md', pattern: /with boris or a repository built from it/, because: 'the sync-ai-layer skill row, naming this repository' },
  { file: 'CLAUDE.md', pattern: /gh api repos\/stevemarvell\/boris/, because: 'the actual GitHub path this repository is checked against', base: true },
  {
    file: 'CLAUDE.md',
    pattern: /arborist crashes/,
    because: '"arborist" contains "boris" as a substring; this quotes npm\'s own error text verbatim',
  },
  { file: 'README.md', pattern: /^# boris$/, because: "this repository's own name", base: true },
  { file: 'README.md', pattern: /Boris Cherny/, because: "the adoption ladder's author", base: true },
  {
    file: 'scripts/labels.mjs',
    pattern: /Every repository built from boris/,
    because: 'naming boris as the master, the same convention sync-ai-layer documents',
  },
  {
    file: 'docs/data-governance.md',
    pattern: /stevemarvell\.github\.io\/boris/,
    because: 'the actual GitHub Pages URL for this repository',
    base: true,
  },

  // The frozen step-0 artifact. CLAUDE.md and apps/web/scripts/build-docs.mjs
  // both say it is published exactly as it was written, never restyled.
  { file: 'index.html', pattern: /<title>boris<\/title>/, because: 'the frozen step-0 artifact; never restyled', base: true },

  // This repository's own package and project name — project.json's `name`
  // is "boris", so npm's lockfile and manifest legitimately say so too.
  { file: 'package.json', pattern: /"name": "boris"/, because: "this repository's own package name", base: true },
  { file: 'package-lock.json', pattern: /"name": "boris"/, because: "this repository's own package name", base: true },
  { file: 'project.json', pattern: /"name": "boris"/, because: "this repository's own name, which project.json declares", base: true },

  // telemetry/ is shared AI-layer infra naming, unrelated to the application
  // and out of scope for identity work that isn't about telemetry itself.
  { file: 'telemetry/docker-compose.yml', pattern: /name: boris-telemetry/, because: 'local compose project namespace, out of this issue\'s scope' },
  { file: 'telemetry/grafana/dashboards/claude-code.json', pattern: /boris/, because: 'Grafana dashboard/datasource naming, out of this issue\'s scope' },
  { file: 'telemetry/grafana/provisioning/dashboards/dashboards.yml', pattern: /name: boris/, because: 'Grafana provisioning naming, out of this issue\'s scope' },
  { file: 'telemetry/grafana/provisioning/datasources/prometheus.yml', pattern: /uid: boris-prometheus/, because: 'Grafana datasource naming, out of this issue\'s scope' },

  // The setup instructions clone this repository by its real path, so
  // README.md's Quick start names it literally.
  { file: 'README.md', pattern: /gh repo clone stevemarvell\/boris/, because: 'the setup instructions clone this repository by its real path', base: true },

  // The remote name `create` gives this base in a product, fetch-only, so a
  // product can fetch upstream improvements and measure how far behind it is
  // without ever pushing to this base by accident. It is also what `check`
  // calls the base when it reports that drift, so no other line names it.
  { file: 'scripts/setup.mjs', pattern: /BASE_REMOTE = 'boris'/, because: "the literal remote name create sets up, not this repository naming itself" },
];

// Every name this repository has to stay neutral about, and that has leaked
// in before: its own, an application it once ran, and a platform it once
// deployed to.
const NAMES = ['boris', 'family-tree', 'family tree', 'family_tree', 'genealog', 'railway'];

/**
 * Whether `line` still names one of NAMES once the checkout's own name is
 * excused (#281). Every NAMES match is found on the original line, and one is
 * excused only if its whole span lies inside an occurrence of `own`: a product
 * called `boris-trial` is not a leftover for containing `boris`, but a product
 * called `ris` does not hide a `boris`, nor `family` a `family-tree`, nor
 * `rail` a `railway`. Case-insensitive, like the grep; `own` is literal. An
 * empty `own` excuses nothing.
 */
export function namesLeft(line: string, own: string): boolean {
  const lower = line.toLowerCase();
  const ownLower = own.toLowerCase();
  const ownSpans: Array<[number, number]> = [];
  if (ownLower) for (let i = lower.indexOf(ownLower); i !== -1; i = lower.indexOf(ownLower, i + 1)) ownSpans.push([i, i + ownLower.length]);
  return NAMES.some((name) => {
    for (let i = lower.indexOf(name); i !== -1; i = lower.indexOf(name, i + 1)) {
      const end = i + name.length;
      if (!ownSpans.some(([from, to]) => from <= i && end <= to)) return true;
    }
    return false;
  });
}

/**
 * In a product, its own name (project.json's `name`) is not a leftover. In
 * boris itself nothing is stripped: the allowlist is what covers its own name.
 */
const OWN_NAME = IN_BASE ? '' : (loadProject(join(ROOT, 'project.json')).name as string);

/** Whether a grep hit still names one of NAMES once the checkout's own name is excused. */
const stillNamesOne = (content: string) => namesLeft(content, OWN_NAME);

/**
 * `git grep -i -n` for every name in NAMES, at the repository root, parsed
 * into `{file, line, content}`. Excludes this file itself: a detector that
 * has to spell every name out, in patterns and in comments explaining them,
 * cannot also be a hit against its own rule. Also excludes
 * scripts/test/setup.test.ts, which tests the rename functions against
 * literal old-name fixtures by design — proving a rename works needs a
 * "boris" to rename, the same way this file needs one to detect.
 */
function grepHits(cwd: string = ROOT) {
  const result = spawnSync(
    'git',
    [
      'grep',
      // Untracked, non-ignored files too: verify runs before the first commit,
      // and a new file must fail here as it will in CI (#257).
      '--untracked',
      '-i',
      '-n',
      ...NAMES.flatMap((name) => ['-e', name]),
      '--',
      '.',
      ':(exclude)scripts/test/identity.test.ts',
      ':(exclude)scripts/test/setup.test.ts',
    ],
    { cwd, encoding: 'utf8' },
  );
  // Exit code 1 means no matches, which is a valid (if surprising) outcome
  // here, not a failure of the command itself.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed: ${result.stderr}`);
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!match) throw new Error(`unparsed git grep line: ${line}`);
      const [, file, lineNo, content] = match;
      return { file: file as string, line: Number(lineNo), content: content as string };
    });
}

/** The entries that describe this checkout: all of them in boris, only the engine's own in a product. */
const applicable = ALLOW.filter((allowed) => IN_BASE || !allowed.base);

describe('no leftover name from NAMES outside the allowlist', () => {
  const hits = grepHits();

  it('finds at least one hit, so an empty result is not read as a pass', () => {
    // A `git grep` that silently matched nothing — a bad pattern, a missing
    // cwd — would otherwise make this whole test vacuously green.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('allows nothing beyond the explicit allowlist', () => {
    const unexplained = hits.filter(
      (hit) => stillNamesOne(hit.content) && !applicable.some((allowed) => allowed.file === hit.file && allowed.pattern.test(hit.content)),
    );
    expect(unexplained).toEqual([]);
  });

  it('keeps the allowlist itself honest: every entry matches a real hit', () => {
    // An entry whose pattern stopped matching anything is hiding nothing —
    // it is dead weight that would mask a genuinely new violation landing on
    // the same file.
    const stale = applicable.filter(
      (allowed) => !hits.some((hit) => hit.file === allowed.file && allowed.pattern.test(hit.content)),
    );
    expect(stale).toEqual([]);
  });
});

describe('an untracked file is seen (#257)', () => {
  // Timeout: real git init and add in a temporary repository (<=100 ms quiet); 15 s.
  it('reports a name in a file that was never git added', { timeout: 15_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    try {
      const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(dir, 'tracked.txt'), 'nothing here\n');
      git('add', 'tracked.txt');
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts', 'new.test.ts'), "it('mentions boris', () => {});\n");
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
      writeFileSync(join(dir, 'ignored.txt'), 'boris\n');
      const hits = grepHits(dir);
      expect(hits.map((hit) => hit.file).sort()).toEqual(['scripts/new.test.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a product's own name is not a leftover (#281)", () => {
  it('excuses the name wherever it occurs, whatever its case', () => {
    expect(namesLeft('"name": "boris-trial", # Boris-Trial', 'boris-trial')).toBe(false);
  });

  it('still catches a bare base name on the same line', () => {
    expect(namesLeft('boris-trial is built from boris', 'boris-trial')).toBe(true);
  });

  it('catches a leftover that the own name only overlaps', () => {
    expect(namesLeft('see boris here', 'ris')).toBe(true);
    expect(namesLeft('the family-tree app', 'family')).toBe(true);
    expect(namesLeft('the family-tree app', 'tree')).toBe(true);
    expect(namesLeft('deployed on railway', 'rail')).toBe(true);
  });

  it('treats the name literally, not as a pattern', () => {
    expect(namesLeft('boris and borxs', 'bor.s')).toBe(true);
    expect(namesLeft('bor.s', 'bor.s')).toBe(false);
  });

  it('excuses nothing for an empty name', () => {
    expect(namesLeft('boris', '')).toBe(true);
    expect(namesLeft('nothing here', '')).toBe(false);
  });
});
