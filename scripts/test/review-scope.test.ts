import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown.mjs';
import {
  GOVERNANCE,
  canonical,
  isProse,
  isWorkflow,
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
