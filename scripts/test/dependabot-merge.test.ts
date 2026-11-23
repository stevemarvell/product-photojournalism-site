import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// .github/workflows/dependabot-merge.yml merges a Dependabot pull request once
// `verify` is green on its head (#422). There is no YAML parser among the
// dependencies, so this reads the file as text. A static test shows the
// controls are written; that the merge really happens is confirmed on the
// first real Dependabot pull request (the issue's done-when).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const text = readFileSync(join(ROOT, '.github/workflows/dependabot-merge.yml'), 'utf8');
const code = text
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** The text of every `run: |` block (lines indented deeper than the key). */
function runBlocks(): string[] {
  const lines = code.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const body = [m[2]!];
    for (let j = i + 1; j < lines.length; j++) {
      const indent = lines[j]!.length - lines[j]!.trimStart().length;
      if (lines[j]!.trim() !== '' && indent <= m[1]!.length) break;
      body.push(lines[j]!);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('dependabot-merge workflow', () => {
  it('triggers on workflow_run of verify, completed, and nothing else', () => {
    expect(code).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \[verify\]\n {4}types: \[completed\]\n/m);
    expect(code).not.toMatch(/pull_request_target|^ {2}pull_request:|^ {2}push:/m);
  });

  it('gates the job itself on a successful verify run of a pull request', () => {
    // The job-level `if:` (four-space indent), not a mention elsewhere.
    const block = /^ {4}if: >-\n((?: {6}\S.*\n)+)/m.exec(code);
    expect(block).not.toBeNull();
    expect(block![1]).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(block![1]).toContain("github.event.workflow_run.event == 'pull_request'");
  });

  it('finds the one open pull request whose head is the verified SHA', () => {
    expect(code).toContain('.head.sha == "\'"$HEAD_SHA"\'"');
    expect(code).toContain('.state == "open"');
    expect(code).toMatch(/if \[ "\$count" -ne 1 \]; then[^\n]*\n[^\n]*\n\s*exit 0/);
  });

  it('reads the author from the API and merges only dependabot[bot]', () => {
    expect(code).toContain('commits/$HEAD_SHA/pulls');
    expect(code).toContain('.user.login');
    expect(code).toMatch(/!= "dependabot\[bot\]"/);
    expect(code).toContain('.base.ref == "develop"');
  });

  it('has exactly contents: write and pull-requests: write', () => {
    const block = /^permissions:\n((?: {2}\S.*\n)+)/m.exec(code);
    expect(block).not.toBeNull();
    expect(block![1]!.trim().split('\n').map((l) => l.trim()).sort()).toEqual([
      'contents: write',
      'pull-requests: write',
    ]);
    expect(code.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it('squash-merges through the REST API pinned to the run head SHA', () => {
    expect(code).toContain('-X PUT "repos/$REPO/pulls/$number/merge"');
    expect(code).toContain('merge_method=squash');
    expect(code).toContain('sha="$HEAD_SHA"');
    expect(code).toContain('HEAD_SHA: ${{ github.event.workflow_run.head_sha }}');
  });

  it('merges nothing when verify is red: no unconditional merge path', () => {
    // The only merge call sits after the author check, and the job's `if`
    // gates it on a success conclusion.
    expect(code.indexOf('!= "dependabot[bot]"')).toBeLessThan(code.indexOf('/merge"'));
    expect(code.match(/\/merge"/g)).toHaveLength(1);
  });

  it('does not check out PR code', () => {
    expect(code).not.toMatch(/actions\/checkout/);
    expect(code).not.toMatch(/\buses:/);
  });

  it('puts no event text inside any run: block', () => {
    const blocks = runBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).not.toMatch(/\$\{\{/);
  });
});
