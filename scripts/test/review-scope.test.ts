import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown.mjs';
import {
  GOVERNANCE,
  canonical,
  isProse,
  isWorkflow,
  COMPARE_FILE_CAP,
  needsSecurityRereview,
  printable,
  reviewScope,
} from '../review-scope.mjs';

describe('reviewScope', () => {
  it('runs both reviews when anything but prose changed', () => {
    const scope = reviewScope(['apps/api/src/api/main.py', 'README.md']);
    expect(scope).toMatchObject({ code: true, security: true });
    expect(scope.why).toContain('apps/api/src/api/main.py');
  });

  it('skips both when every changed file is prose', () => {
    expect(reviewScope(['docs/adoption.md', 'README.md'])).toMatchObject({
      code: false,
      security: false,
    });
  });

  it('reviews a governance-only change for security but not for code', () => {
    // There is no code in that file, and the whole security posture is in it.
    expect(reviewScope([GOVERNANCE])).toMatchObject({ code: false, security: true });
  });

  it('does not treat the reviewers own rubrics as prose', () => {
    // Otherwise a pull request gutting security-checker.md skips its own
    // security review — the reviewer would be disarmed by the change it was
    // there to catch.
    for (const rubric of ['.claude/agents/security-checker.md', '.claude/agents/code-checker.md']) {
      expect(isProse(rubric)).toBe(false);
      expect(reviewScope([rubric])).toMatchObject({ code: true, security: true });
    }
  });

  it('folds case everywhere a path is compared, not just on the extension', () => {
    // An extension test that lowercases while the prefix tests do not would
    // let `.CLAUDE/...` skip both reviews — the exact disarming the test
    // above exists to prevent — and `docs/data-governance.MD` skip the
    // security review of the file that *is* the security posture.
    expect(isProse('.CLAUDE/agents/security-checker.md')).toBe(false);
    expect(reviewScope(['.CLAUDE/agents/security-checker.md'])).toMatchObject({
      code: true,
      security: true,
    });
    expect(reviewScope(['.GITHUB/workflows/verify.md'])).toMatchObject({
      code: true,
      security: true,
    });
    expect(reviewScope(['docs/data-governance.MD'])).toMatchObject({
      code: false,
      security: true,
    });
  });

  it('routes every comparison through one normalisation', () => {
    // The defect was two spellings of "the same path". Asserting the helper
    // directly is what stops a future comparison growing its own.
    expect(canonical('  ./Docs/Data-Governance.MD  ')).toBe(GOVERNANCE);
  });

  it('does not treat Markdown under .github as prose', () => {
    expect(reviewScope(['.github/PULL_REQUEST_TEMPLATE.md'])).toMatchObject({
      code: true,
      security: true,
    });
  });

  it('reviews a workflow change', () => {
    expect(reviewScope(['.github/workflows/verify.yml'])).toMatchObject({
      code: true,
      security: true,
    });
  });

  it('reports whether a workflow file changed, for the check that needs it', () => {
    // With no execution log, assert-review-ran.mjs can only tell the
    // action's workflow-validation skip from a session that failed to start
    // if somebody tells it which. This is that somebody.
    expect(reviewScope(['.github/workflows/verify.yml']).workflows).toBe(true);
    expect(reviewScope(['.GITHUB/WORKFLOWS/verify.yml']).workflows).toBe(true);
    expect(reviewScope(['./.github/workflows/verify.yml']).workflows).toBe(true);
    expect(isWorkflow('.github/workflows/claude-code-review.yml')).toBe(true);
  });

  it('does not call every .github change a workflow change', () => {
    // A dependabot config or an issue template changes nothing about whether
    // the action will start a session.
    expect(isWorkflow('.github/dependabot.yml')).toBe(false);
    expect(reviewScope(['.github/dependabot.yml']).workflows).toBe(false);
    expect(reviewScope(['apps/web/src/App.tsx', 'docs/adoption.md']).workflows).toBe(false);
  });

  it('claims no workflow knowledge when it had no file list', () => {
    // Both reviews run, as ever — but `workflows` is a fact about the diff,
    // and there was no diff to read. It must not be reported as true.
    expect(reviewScope([])).toMatchObject({ code: true, security: true, workflows: false });
  });

  it('reviews a change to real application data', () => {
    // Today's apps are placeholder shells with no data file at all, and
    // docs/data-governance.md says the trigger that voids that decision is
    // real data arriving. A change under a data path is exactly when someone
    // should look.
    expect(reviewScope(['apps/api/data/example.json'])).toMatchObject({ code: true, security: true });
  });

  it('runs both reviews when it has no file list', () => {
    // A scope step whose API call failed must not be the reason a change goes
    // unreviewed. The failure this repository keeps paying for is a filter
    // that skipped something and said nothing.
    for (const empty of [[], [''], ['   ', '']]) {
      expect(reviewScope(empty)).toMatchObject({ code: true, security: true });
    }
  });

  it('says what it decided and why, every time', () => {
    for (const files of [['apps/web/src/App.tsx'], ['docs/adoption.md'], [GOVERNANCE], []]) {
      expect(reviewScope(files).why.length).toBeGreaterThan(20);
    }
  });

  it('is not fooled by a leading ./ or a capitalised extension', () => {
    expect(reviewScope(['./docs/adoption.MD'])).toMatchObject({ code: false, security: false });
    expect(reviewScope([`./${GOVERNANCE}`])).toMatchObject({ code: false, security: true });
  });
});

describe('the premise that lets prose be skipped', () => {
  // Skipping Markdown is only safe because scripts/markdown.mjs cannot emit
  // script into the docs site Vercel serves. That is an assumption about
  // another file, so it is checked here rather than asserted in a comment: a
  // renderer that started passing raw HTML through would turn a .md change
  // into a deployment change, and the skip above into a hole.
  it('escapes raw HTML rather than passing it through', () => {
    const html = renderMarkdown('An <script>alert(1)</script> in a paragraph.\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses a javascript: link', () => {
    // It renders as the literal text the author typed, so the string survives
    // — what must not survive is the anchor. Asserting on the text would pass
    // for the wrong reason.
    const html = renderMarkdown('[click](javascript:alert(1))\n');
    expect(html).not.toMatch(/<a\s/);
    expect(html).toContain('[click](javascript:alert(1))');
  });
});

describe('needsSecurityRereview, the driver rule before merging', () => {
  it('is needed when the diff since the last review touches .github/ or code', () => {
    expect(needsSecurityRereview(['.github/workflows/verify.yml'])).toBe(true);
    expect(needsSecurityRereview(['.github/CODEOWNERS.md'])).toBe(true);
    expect(needsSecurityRereview(['apps/api/src/api/main.py', 'README.md'])).toBe(true);
    expect(needsSecurityRereview(['.claude/agents/security-checker.md'])).toBe(true);
    expect(needsSecurityRereview([GOVERNANCE])).toBe(true);
  });

  it('is not needed for prose outside .claude/ and .github/', () => {
    expect(needsSecurityRereview(['README.md', 'docs/sops.md'])).toBe(false);
  });

  it('is needed when the diff could not be read, rather than merging unreviewed', () => {
    expect(needsSecurityRereview([])).toBe(true);
    expect(needsSecurityRereview(['', '\n'])).toBe(true);
  });

  it('agrees with reviewScope for the same paths, and the CLI flag prints it', { timeout: 15_000 }, () => {
    const paths = ['docs/sops.md', 'scripts/review-scope.mjs'];
    expect(needsSecurityRereview(paths)).toBe(reviewScope(paths).security);
    const run = (input: string) =>
      spawnSync('node', ['scripts/review-scope.mjs', '--since'], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
        input,
        encoding: 'utf8',
      });
    const needed = run('.github/workflows/verify.yml\n');
    expect(needed.status).toBe(0);
    expect(needed.stdout).toContain('re-review: needed');
    const notNeeded = run('README.md\ndocs/sops.md\n');
    expect(notNeeded.status).toBe(0);
    expect(notNeeded.stdout).toContain('re-review: not needed');
  });
});

describe('the --since edge cases', () => {
  it('treats a file list at the compare cap as needing a review, however harmless the names', () => {
    const docs = Array.from({ length: COMPARE_FILE_CAP }, (_, i) => `docs/page-${i}.md`);
    expect(needsSecurityRereview(docs.slice(1))).toBe(false);
    expect(needsSecurityRereview(docs)).toBe(true);
  });

  it('prints no control character from a file name', { timeout: 15_000 }, () => {
    expect(printable('a\u001b[2Jb\rc\u0085d\u007fe')).toBe('a?[2Jb?c?d?e');
    const run = spawnSync('node', ['scripts/review-scope.mjs', '--since'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
      input: 'evil\u001b]0;pwned\u0007.py\n',
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(run.status).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(run.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(run.stdout).toContain('touches .github/workflows/: false');
  });

  it('reports a workflow edit, which the review action cannot review, on the --since output', { timeout: 15_000 }, () => {
    const run = spawnSync('node', ['scripts/review-scope.mjs', '--since'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
      input: '.github/workflows/verify.yml\n',
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(run.stdout).toContain('touches .github/workflows/: true');
  });
});

describe('--since over a long list, taken from git', () => {
  const run = (names: string[]) =>
    spawnSync('node', ['scripts/review-scope.mjs', '--since'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
      input: `${names.join('\n')}\n`,
      encoding: 'utf8',
      timeout: 15_000,
    });
  const docs = (n: number) => Array.from({ length: n }, (_, i) => `docs/page-${i}.md`);

  it('sees a security-relevant path that is only the 31st name', { timeout: 15_000 }, () => {
    const names = [...docs(30), 'apps/api/src/api/main.py'];
    expect(names).toHaveLength(31);
    expect(needsSecurityRereview(names)).toBe(true);
    expect(run(names).stdout).toContain('re-review: needed');
  });

  it('says not needed when all 31 names are plain prose', { timeout: 15_000 }, () => {
    expect(run(docs(31)).stdout).toContain('re-review: not needed');
  });
});

describe('--since over a rename, taken from a real git repository', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const since = (names: string) =>
    spawnSync('node', [resolve(root, 'scripts/review-scope.mjs'), '--since'], { input: names, encoding: 'utf8', timeout: 15_000 }).stdout;

  it('lists the old path too with --no-renames, so a move to prose is still re-reviewed', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'rename-scope-'));
    try {
      git(dir, ['init', '-q']);
      mkdirSync(resolve(dir, 'apps/api/src'), { recursive: true });
      mkdirSync(resolve(dir, 'docs'));
      writeFileSync(resolve(dir, 'apps/api/src/auth.py'), 'def check(token):\n    return token == "x"\n'.repeat(5));
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'add auth']);
      const a = git(dir, ['rev-parse', 'HEAD']);
      git(dir, ['mv', 'apps/api/src/auth.py', 'docs/auth.md']);
      git(dir, ['commit', '-qm', 'rename to prose']);
      const b = git(dir, ['rev-parse', 'HEAD']);

      const fixed = git(dir, ['diff', '--name-only', '--no-renames', `${a}...${b}`]);
      expect(fixed.split('\n').sort()).toEqual(['apps/api/src/auth.py', 'docs/auth.md']);
      expect(since(`${fixed}\n`)).toContain('re-review: needed');

      // Without the flag git collapses the rename to its new path, which is
      // prose: this is what proves the assertion above is not vacuous.
      const collapsed = git(dir, ['diff', '--name-only', `${a}...${b}`]);
      expect(collapsed).toBe('docs/auth.md');
      expect(since(`${collapsed}\n`)).toContain('re-review: not needed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
