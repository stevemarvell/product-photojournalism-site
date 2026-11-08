import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_REMOTE,
  MARK,
  OWNER_ISSUES,
  parseGithubRepo,
  branchProtectionDecision,
  engineDrift,
  ensureEmptyTarget,
  missingOwnerIssues,
  missingPreflight,
  needsTemplateIssue,
  parseCheckArgs,
  exec,
  create,
  parseAddArgs,
  needsShell,
  shellCommand,
  spawnTool,
  parseCreateArgs,
  preflight,
  renderCheck,
  runCheck,
  type Run,
} from '../setup.mjs';
import { ROOT } from '../project.mjs';

describe('stripped `--` (#276)', () => {
  const stripped = ['create', 'boris-trial', 'stevemarvell', 'python-fastapi', 'node-react'];

  it('create refuses bare values with the cause and the node form', () => {
    const run = () => parseCreateArgs(stripped.slice(1));
    expect(run).toThrow(/no flags/);
    expect(run).toThrow(/Windows PowerShell/);
    expect(run).toThrow(/node scripts\/setup\.mjs create --name <n> --owner <o>/);
    expect(run).not.toThrow(/unknown flag/);
  });

  it('check refuses bare values the same way', () => {
    const run = () => parseCheckArgs(['x', 'y']);
    expect(run).toThrow(/node scripts\/setup\.mjs check/);
    expect(run).not.toThrow(/unknown flag/);
  });

  it('the CLI refuses the exact stripped argv, exit non-zero, no network', () => {
    // Resolved from this file, not the working directory, so it holds wherever vitest runs.
    const script = fileURLToPath(new URL('../setup.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, ...stripped], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 20_000,
      cwd: tmpdir(),
    });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toMatch(/node scripts\/setup\.mjs create --name/);
    expect(r.stderr).not.toMatch(/unknown flag/);
  }, 30_000);

  it('a real unknown flag still gets the usage error', () => {
    expect(() => parseCheckArgs(['--nope'])).toThrow(/unknown flag "--nope"/);
  });
});

describe('parseCreateArgs', () => {
  it('parses --name, --owner, --dir, --public, a repeated --starter and --deploy', () => {
    expect(
      parseCreateArgs(['--name', 'n', '--owner', 'o', '--dir', '../n', '--public', '--starter', 'a', '--starter', 'b', '--deploy', 'vercel']),
    ).toEqual({ name: 'n', owner: 'o', dir: '../n', public: true, starters: ['a', 'b'], deploy: 'vercel' });
  });

  it('defaults --dir to ../<name>, --public to false, and chooses no starters and no provider', () => {
    const opts = parseCreateArgs(['--name', 'n', '--owner', 'o']);
    expect(opts).toEqual({ name: 'n', owner: 'o', dir: '../n', public: false, starters: [] });
    expect(opts.deploy).toBeUndefined();
  });

  it('requires --name', () => {
    expect(() => parseCreateArgs(['--owner', 'o'])).toThrow(/--name/);
  });

  it('requires --owner', () => {
    expect(() => parseCreateArgs(['--name', 'n'])).toThrow(/--owner/);
  });

  it('refuses an owner that is not a GitHub login or organisation name, before anything runs', () => {
    for (const owner of ['x/../../orgs/y', 'a?b', 'a/b', '-a']) {
      expect(() => parseCreateArgs(['--name', 'n', '--owner', owner]), owner).toThrow(/owner/);
    }
  });

  it('refuses an unknown flag, naming the usage', () => {
    expect(() => parseCreateArgs(['--name', 'n', '--owner', 'o', '--nope'])).toThrow(/unknown flag "--nope"/);
    expect(() => parseCreateArgs(['--name', 'n', '--owner', 'o', '--nope'])).toThrow(/--starter/);
  });

  it('refuses a flag with no value', () => {
    expect(() => parseCreateArgs(['--name'])).toThrow(/needs a value/);
    expect(() => parseCreateArgs(['--name', 'n', '--owner', 'o', '--starter'])).toThrow(/--starter needs a value/);
    expect(() => parseCreateArgs(['--name', 'n', '--owner', 'o', '--deploy'])).toThrow(/--deploy needs a value/);
  });

  it('refuses a flag whose value looks like another flag', () => {
    expect(() => parseCreateArgs(['--name', '--owner', 'o'])).toThrow(/needs a value/);
  });
});

describe('parseCheckArgs', () => {
  it('defaults everything to off', () => {
    expect(parseCheckArgs([])).toEqual({ skipVerify: false, dryRun: false });
  });

  it('parses --skip-verify, --dry-run and --repo', () => {
    expect(parseCheckArgs(['--skip-verify', '--dry-run', '--repo', 'o/n'])).toEqual({
      skipVerify: true,
      dryRun: true,
      repo: 'o/n',
    });
  });

  it('refuses an unknown flag', () => {
    expect(() => parseCheckArgs(['--nope'])).toThrow(/unknown flag/);
  });

  it('refuses --repo with no value', () => {
    expect(() => parseCheckArgs(['--repo'])).toThrow(/needs a value/);
  });
});

describe('preflight', () => {
  it('reports every check ok when every command succeeds and Node is new enough', async () => {
    const run: Run = async () => ({ status: 0, stdout: 'x', stderr: '' });
    const results = await preflight({ run, nodeVersion: 'v22.1.0' });
    expect(missingPreflight(results)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(['gh api user', 'git', 'node >= 22', 'uv', 'npx npm@11']);
  });

  it('leaves uv out when the product has no Python app, so a machine without it can still make one', async () => {
    const run: Run = async (cmd) => (cmd === 'uv' ? { status: 1, stdout: '', stderr: 'not found' } : { status: 0, stdout: 'x', stderr: '' });
    const results = await preflight({ run, nodeVersion: 'v22.1.0', python: false });
    expect(missingPreflight(results)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(['gh api user', 'git', 'node >= 22', 'npx npm@11']);
  });

  it('names what failed when a command fails, with its stderr', async () => {
    const run: Run = async (cmd) => (cmd === 'uv' ? { status: 1, stdout: '', stderr: 'not found' } : { status: 0, stdout: 'x', stderr: '' });
    const results = await preflight({ run, nodeVersion: 'v22.1.0' });
    const missing = missingPreflight(results);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ name: 'uv', detail: 'not found' });
  });

  it('fails the node check under Node 22, regardless of what the commands report', async () => {
    const run: Run = async () => ({ status: 0, stdout: 'x', stderr: '' });
    const results = await preflight({ run, nodeVersion: 'v20.11.0' });
    const missing = missingPreflight(results);
    expect(missing.map((r) => r.name)).toEqual(['node >= 22']);
  });

  it('passes the node check at exactly 22', async () => {
    const run: Run = async () => ({ status: 0, stdout: 'x', stderr: '' });
    const results = await preflight({ run, nodeVersion: 'v22.0.0' });
    expect(missingPreflight(results)).toEqual([]);
  });
});

describe('renderCheck', () => {
  it('exits 0 when every line is ✔ or ✚', () => {
    const { lines, exitCode } = renderCheck([
      { mark: MARK.done, text: 'a' },
      { mark: MARK.fixed, text: 'b' },
    ]);
    expect(lines).toEqual(['✔ a', '✚ b']);
    expect(exitCode).toBe(0);
  });

  it('exits 1 when any line is ✋, regardless of position', () => {
    expect(renderCheck([{ mark: MARK.done, text: 'a' }, { mark: MARK.owner, text: 'b' }]).exitCode).toBe(1);
    expect(renderCheck([{ mark: MARK.owner, text: 'a' }, { mark: MARK.done, text: 'b' }]).exitCode).toBe(1);
  });

  it('exits 0 on an empty list', () => {
    expect(renderCheck([]).exitCode).toBe(0);
  });
});

describe('branchProtectionDecision', () => {
  it('fixes it for a public repository', () => {
    const d = branchProtectionDecision({ isPrivate: false });
    expect(d.mark).toBe(MARK.fixed);
    expect(d.text).toMatch(/develop/);
  });

  it('calls it discipline for a private, free-plan repository', () => {
    const d = branchProtectionDecision({ isPrivate: true });
    expect(d.mark).toBe(MARK.done);
    expect(d.text).toMatch(/discipline/);
  });
});

describe('missingOwnerIssues', () => {
  it('returns every owner issue when none exist yet', () => {
    expect(missingOwnerIssues([])).toEqual(OWNER_ISSUES);
  });

  it('excludes an issue that already exists, by exact title', () => {
    const existing = [OWNER_ISSUES[0]!.title];
    const missing = missingOwnerIssues(existing);
    expect(missing).toHaveLength(OWNER_ISSUES.length - 1);
    expect(missing.some((i) => i.title === OWNER_ISSUES[0]!.title)).toBe(false);
  });

  it('is not fooled by a closed issue counting as existing: callers pass --state all', () => {
    // missingOwnerIssues itself only ever sees titles; this documents why
    // runCheck fetches issue titles with --state all rather than the
    // open-only default, so a person who already closed one of these by
    // hand never gets it recreated.
    expect(missingOwnerIssues([OWNER_ISSUES[1]!.title])).not.toContainEqual(OWNER_ISSUES[1]);
  });

  it('returns nothing once every owner issue already exists, so a re-run creates nothing new', () => {
    expect(missingOwnerIssues(OWNER_ISSUES.map((i) => i.title))).toEqual([]);
  });
});

describe('needsTemplateIssue', () => {
  it('is true when no open issue carries the template label', () => {
    expect(needsTemplateIssue([{ labels: ['bug'] }])).toBe(true);
    expect(needsTemplateIssue([])).toBe(true);
  });

  it('is false once one does, so a re-run never files a second one', () => {
    expect(needsTemplateIssue([{ labels: ['bug'] }, { labels: ['template'] }])).toBe(false);
  });
});

describe('parseGithubRepo', () => {
  it('reads ssh, scp-like and https origins, with or without .git', () => {
    for (const url of [
      'git@github.com:octo/proj.git',
      'git@github.com:octo/proj',
      'ssh://git@github.com/octo/proj.git',
      'https://github.com/octo/proj.git',
      'https://user:tok@github.com/octo/proj\n',
    ]) expect(parseGithubRepo(url), url).toBe('octo/proj');
  });

  it('is null for anything else', () => {
    for (const url of ['', 'DISABLED', 'git@gitlab.com:octo/proj.git', '/srv/git/proj.git', 'https://github.com/octo']) {
      expect(parseGithubRepo(url), url).toBeNull();
    }
  });
});

describe('runCheck', () => {
  function run(responses: Record<string, RunResultLike>): Run {
    return async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      for (const [prefix, result] of Object.entries(responses)) {
        // A leading `*` matches anywhere in the command, for routes that name a root the test does not control.
        if (prefix.startsWith('*') ? key.includes(prefix.slice(1)) : key.startsWith(prefix)) return result;
      }
      throw new Error(`unexpected call: ${key}`);
    };
  }

  type RunResultLike = { status: number; stdout: string; stderr: string };

  // runCheck's own real default for this spawns `npx vitest run
  // scripts/test/identity.test.ts`, which is exactly right in production and
  // exactly wrong recursed into from inside this test run — every test below
  // stubs it unless it is itself testing this path.
  const identityOk = () => ({ ok: true, output: '' });

  // A root whose project.json deploys nothing. The default root is this repository, and a repository
  // built from it that has run `deploy:add` has a deploy block there: `check` then also asks Vercel
  // whether the app answers and gh for VERCEL_TOKEN, none of which these tests stub or are about.
  let neutral: string;
  beforeEach(() => {
    neutral = mkdtempSync(join(tmpdir(), 'setup-neutral-'));
    writeFileSync(join(neutral, 'project.json'), JSON.stringify({ name: 'acme', apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] } } }));
  });
  afterEach(() => rmSync(neutral, { recursive: true, force: true }));

  const restIssue = (title: string, labels: string[] = []) => ({ title, labels: labels.map((name) => ({ name })) });
  const repoJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ private: true, delete_branch_on_merge: true, html_url: 'https://x', ...over });

  // Prefix-matched in insertion order, so the specific routes come before the
  // bare repository route they all begin with.
  const baseResponses: Record<string, RunResultLike> = {
    'gh api repos/octo/proj/labels': { status: 0, stdout: JSON.stringify([]), stderr: '' },
    'gh api repos/octo/proj/issues?state=all': {
      status: 0,
      stdout: JSON.stringify(OWNER_ISSUES.map((i) => restIssue(i.title))),
      stderr: '',
    },
    'gh api repos/octo/proj/issues?state=open': {
      status: 0,
      stdout: JSON.stringify([restIssue('Template: User story', ['template'])]),
      stderr: '',
    },
    'gh api user': { status: 0, stdout: 'octocat\n', stderr: '' },
    'gh secret list': { status: 0, stdout: JSON.stringify([{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }]), stderr: '' },
    'gh api repos/octo/proj': { status: 0, stdout: repoJson(), stderr: '' },
    // `check` names the repository from origin; gh's {owner}/{repo} placeholders prompt when there are two remotes.
    '* remote get-url origin': { status: 0, stdout: 'git@github.com:octo/proj.git\n', stderr: '' },
    // Only a product records the base commit it came from, and then `check` asks git how far behind it is.
    // These tests run in whichever repository this file is in, so git answers with nothing here.
    'git -C': { status: 0, stdout: '', stderr: '' },
  };

  it('exits 0 when every check is already satisfied', async () => {
    const result = await runCheck({ root: neutral, run: run(baseResponses), skipVerify: true, runIdentityTest: identityOk });
    expect(result.exitCode).toBe(0);
    expect(result.lines.some((l) => l.startsWith(MARK.owner))).toBe(false);
  });

  it('names the repository from an https origin too, and never uses the {owner}/{repo} placeholders', async () => {
    const calls: string[][] = [];
    const swap = (k: string, v: RunResultLike): [string, RunResultLike] => [k.replace('octo/proj', 'acme/widget'), v];
    const inner = run({
      ...Object.fromEntries(Object.entries(baseResponses).map(([k, v]) => swap(k, v))),
      '* remote get-url origin': { status: 0, stdout: 'https://github.com/acme/widget.git\n', stderr: '' },
    });
    const result = await runCheck({
      root: neutral,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return inner(cmd, args);
      },
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    expect(result.exitCode).toBe(0);
    const gh = calls.filter((c) => c[0] === 'gh');
    expect(gh.some((c) => c.join(' ').includes('{owner}'))).toBe(false);
    expect(gh).toContainEqual(['gh', 'secret', 'list', '--json', 'name', '--repo', 'acme/widget']);
    expect(gh.some((c) => c[1] === 'api' && c[2]!.startsWith('repos/acme/widget'))).toBe(true);
  });

  it('uses the repo it is given without asking origin', async () => {
    const calls: string[][] = [];
    await expect(
      runCheck({
        repo: 'a/b',
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
          return { status: 1, stdout: '', stderr: 'stop' };
        },
        skipVerify: true,
        runIdentityTest: identityOk,
      }),
    ).rejects.toThrow();
    expect(calls.some((c) => c[0] === 'git' && c.includes('get-url'))).toBe(false);
  });

  it('fails clearly, before any gh call, when origin is not a github.com URL', async () => {
    for (const origin of [{ status: 0, stdout: '/srv/git/p.git\n', stderr: '' }, { status: 2, stdout: '', stderr: 'no such remote' }]) {
      const calls: string[][] = [];
      await expect(
        runCheck({
          run: async (cmd, args) => {
            calls.push([cmd, ...args]);
            return origin;
          },
          skipVerify: true,
          runIdentityTest: identityOk,
        }),
      ).rejects.toThrow(/cannot tell which repository.*--repo <owner>\/<name>/);
      expect(calls.some((c) => c[0] === 'gh')).toBe(false);
    }
  });

  it('prints the owner steps with -R owner/name', async () => {
    const result = await runCheck({
      run: run({ ...baseResponses, 'gh secret list': { status: 0, stdout: '[]', stderr: '' } }),
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    expect(result.lines.some((l) => l.includes('gh secret set CLAUDE_CODE_OAUTH_TOKEN -R octo/proj'))).toBe(true);
    expect(OWNER_ISSUES[0]!.body('octo/proj')).toContain('gh secret set CLAUDE_CODE_OAUTH_TOKEN -R octo/proj');
  });

  it('reports an owner action, and exits 1, when CLAUDE_CODE_OAUTH_TOKEN is missing', async () => {
    const result = await runCheck({
      run: run({ ...baseResponses, 'gh secret list': { status: 0, stdout: '[]', stderr: '' } }),
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((l) => l.includes('CLAUDE_CODE_OAUTH_TOKEN') && l.startsWith(MARK.owner))).toBe(true);
  });

  it('under --dry-run, reports what it would do as an owner action rather than doing it', async () => {
    const calls: string[] = [];
    const dryRun = run({
      ...baseResponses,
      'gh api repos/octo/proj': { status: 0, stdout: repoJson({ delete_branch_on_merge: false }), stderr: '' },
    });
    const result = await runCheck({
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return dryRun(cmd, args);
      },
      dryRun: true,
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((l) => l.includes('delete_branch_on_merge') && l.startsWith(MARK.owner))).toBe(true);
    expect(calls.some((c) => c.includes('delete_branch_on_merge=true'))).toBe(false);
  });

  it('files a missing owner issue, labelled human and do not automate, and reports it fixed', async () => {
    const calls: string[][] = [];
    const result = await runCheck({
      root: neutral,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'gh' && args[0] === 'api' && args[1]!.includes('/issues?state=all')) {
          return { status: 0, stdout: JSON.stringify(OWNER_ISSUES.slice(1).map((i) => restIssue(i.title))), stderr: '' };
        }
        if (cmd === 'gh' && args.includes('POST') && args[1]!.endsWith('/issues')) return { status: 0, stdout: '', stderr: '' };
        return run(baseResponses)(cmd, args);
      },
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    const createCall = calls.find((c) => c.includes('POST') && c.includes(`title=${OWNER_ISSUES[0]!.title}`));
    expect(createCall).toBeDefined();
    expect(createCall!.slice(0, 3)).toEqual(['gh', 'api', 'repos/octo/proj/issues']);
    expect(createCall).toContain('labels[]=human');
    expect(createCall).toContain('labels[]=do not automate');
    expect(createCall).toContain('assignees[]=octocat');
    // REST, never `gh issue create` (GraphQL, refused from cloud sessions).
    expect(calls.some((c) => c[1] === 'issue')).toBe(false);
    expect(result.lines.some((l) => l.includes(OWNER_ISSUES[0]!.title) && l.startsWith(MARK.fixed))).toBe(true);
  });

  it('every owner issue body is a function returning a non-empty string', () => {
    for (const issue of OWNER_ISSUES) {
      expect(typeof issue.body, issue.title).toBe('function');
      const text = issue.body('o/n');
      expect(typeof text, issue.title).toBe('string');
      expect(text.length, issue.title).toBeGreaterThan(0);
    }
  });

  it('files every owner issue when all are missing, without throwing, each with a string body', async () => {
    const calls: string[][] = [];
    await runCheck({
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'gh' && args[0] === 'api' && args[1]!.includes('/issues?state=all')) {
          return { status: 0, stdout: JSON.stringify([]), stderr: '' };
        }
        if (cmd === 'gh' && args.includes('POST') && args[1]!.endsWith('/issues')) return { status: 0, stdout: '', stderr: '' };
        return run(baseResponses)(cmd, args);
      },
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    for (const issue of OWNER_ISSUES) {
      const call = calls.find((c) => c.includes('POST') && c.includes(`title=${issue.title}`));
      expect(call, issue.title).toBeDefined();
      const body = call!.find((a) => a.startsWith('body='));
      expect(body, issue.title).toBeDefined();
      expect(body!.length, issue.title).toBeGreaterThan('body='.length);
      expect(body).not.toContain('undefined');
    }
  });

  it('files the template issue from .github/ISSUE_TEMPLATE/story.md, body equal to the file minus its front matter', async () => {
    const calls: string[][] = [];
    await runCheck({
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'gh' && args[1]?.includes('/issues?state=open')) return { status: 0, stdout: '[]', stderr: '' };
        if (cmd === 'gh' && args.includes('POST') && args[1]!.endsWith('/issues')) return { status: 0, stdout: '', stderr: '' };
        return run(baseResponses)(cmd, args);
      },
      skipVerify: true,
      runIdentityTest: identityOk,
    });
    const raw = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/story.md'), 'utf8');
    const parts = raw.split('\n---\n');
    expect(raw.startsWith('---\n')).toBe(true);
    const frontMatter = parts[0]!;
    expect(frontMatter).toContain('name: User story');
    expect(frontMatter).not.toMatch(/^labels:\s*\S/m);
    const expectedBody = raw.slice(raw.indexOf('\n---\n', 3) + 5).replace(/^\n+/, '');
    const createCall = calls.find((c) => c.includes('POST') && c.includes('labels[]=template'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain(`body=${expectedBody}`);
    expect(expectedBody.startsWith('## Persona')).toBe(true);
    expect(existsSync(join(ROOT, 'scripts/setup/story-template.md'))).toBe(false);
  });

  it('keeps the whole of `about` when the front matter is read the way YAML reads it (an unquoted " #" starts a comment)', () => {
    const raw = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/story.md'), 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith('about:'))!;
    const value = line.slice('about:'.length).trim();
    // A minimal YAML scalar read: quoted values run to the closing quote; plain ones stop at " #".
    const quoted = /^(["'])(.*)\1$/.exec(value);
    const parsed = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '');
    expect(parsed).toContain('Depends on #<n> lines last.');
    expect(quoted).not.toBeNull();
  });

  it('refuses to file owner issues unassigned: a failed login lookup is a failure, not a quiet filing', async () => {
    const calls: string[][] = [];
    await expect(
      runCheck({
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === 'gh' && args[0] === 'api' && args[1]!.includes('/issues?state=all')) {
            return { status: 0, stdout: JSON.stringify(OWNER_ISSUES.slice(1).map((i) => restIssue(i.title))), stderr: '' };
          }
          if (cmd === 'gh' && args[1] === 'user') return { status: 1, stdout: '', stderr: 'HTTP 403' };
          return run(baseResponses)(cmd, args);
        },
        skipVerify: true,
        runIdentityTest: identityOk,
      }),
    ).rejects.toThrow(/gh api user failed: HTTP 403/);
    expect(calls.some((c) => c.includes('POST') && c.some((a) => a.endsWith('/issues')))).toBe(false);
  });

  it('reports the identity census done when scripts/test/identity.test.ts passes', async () => {
    const result = await runCheck({ run: run(baseResponses), skipVerify: true, runIdentityTest: identityOk });
    expect(result.lines.some((l) => l.includes('identity census') && l.startsWith(MARK.done))).toBe(true);
  });

  it('reports the identity census as an owner action, with the trimmed failure output, when the real test fails', async () => {
    const result = await runCheck({
      run: run(baseResponses),
      skipVerify: true,
      runIdentityTest: () => ({ ok: false, output: 'FAIL scripts/test/identity.test.ts\napps/web/src/leftover.ts names the base' }),
    });
    expect(result.exitCode).toBe(1);
    const line = result.lines.find((l) => l.includes('identity census'));
    expect(line).toBeDefined();
    expect(line).toMatch(new RegExp(`^${MARK.owner}`));
    expect(line).toContain('apps/web/src/leftover.ts names the base');
  });

  // Timeout (the 30 s at the end): spawns a real vitest process on identity.test.ts (1.1 s quiet, ~27x).
  it('runs the real identity test by default, not a re-derived allowlist', async () => {
    // No runIdentityTest override: this exercises the real default, which
    // spawns scripts/test/identity.test.ts itself via vitest — proving the
    // census is the actual test, not a second copy of what it allows.
    const result = await runCheck({ root: neutral, run: run(baseResponses), skipVerify: true });
    const line = result.lines.find((l) => l.includes('identity census'));
    expect(line).toBeDefined();
    expect(line).toMatch(new RegExp(`^${MARK.done}`));
  }, 30_000);

  it('skips npm run verify under --skip-verify, and reports it fixed/done rather than owner', async () => {
    const result = await runCheck({ run: run(baseResponses), skipVerify: true, runIdentityTest: identityOk });
    expect(result.lines.some((l) => l.includes('verify') && l.includes('skipped'))).toBe(true);
  });

  it('reports npm run verify as an owner action when it fails', async () => {
    const result = await runCheck({ run: run(baseResponses), skipVerify: false, runVerify: () => 1, runIdentityTest: identityOk });
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((l) => l.includes('verify') && l.startsWith(MARK.owner))).toBe(true);
  });

  it('reports no deployed app to check when project.json deploys nothing', async () => {
    const result = await runCheck({ root: neutral, run: run(baseResponses), skipVerify: true, runIdentityTest: identityOk });
    expect(result.lines.some((l) => l.includes('no app has a deploy block'))).toBe(true);
  });

  it('always prints the closing next-steps section', async () => {
    const result = await runCheck({ run: run(baseResponses), skipVerify: true, runIdentityTest: identityOk });
    expect(result.lines.some((l) => l.includes('work-backlog'))).toBe(true);
  });

  describe('the base commit a product records', () => {
    const COMMIT = '0123456789abcdef0123456789abcdef01234567';
    let product: string;
    beforeEach(() => {
      product = mkdtempSync(join(tmpdir(), 'setup-product-'));
      writeFileSync(
        join(product, 'project.json'),
        JSON.stringify({ name: 'acme', engine: { commit: COMMIT }, apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] } } }),
      );
    });
    afterEach(() => rmSync(product, { recursive: true, force: true }));

    it('reports how far behind the base it is as an informational line, not an owner action', async () => {
      const seen: string[] = [];
      const result = await runCheck({
        root: product,
        repo: 'octo/proj',
        skipVerify: true,
        runIdentityTest: identityOk,
        run: async (cmd, args) => {
          const key = `${cmd} ${args.join(' ')}`;
          if (cmd === 'git') {
            seen.push(key);
            if (args.includes('rev-list')) return { status: 0, stdout: '4\n', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
          }
          return run(baseResponses)(cmd, args);
        },
      });
      const line = result.lines.find((l) => l.includes('behind'));
      expect(line).toBe(`${MARK.info} behind ${BASE_REMOTE} by 4 commits (engine.commit 0123456); the sync-ai-layer skill brings them in and moves engine.commit`);
      // It is read from the product's own checkout, never this one.
      expect(seen.every((k) => k.startsWith(`git -C ${product} `))).toBe(true);
      expect(seen[0]).toBe(`git -C ${product} fetch --no-tags ${BASE_REMOTE} develop`);
      expect(result.exitCode).toBe(0);
    });

    it('does not fetch under --dry-run, which writes nothing, and says the drift check was skipped', async () => {
      const result = await runCheck({
        root: product,
        repo: 'octo/proj',
        dryRun: true,
        skipVerify: true,
        runIdentityTest: identityOk,
        run: async (cmd, args) => {
          if (cmd === 'git') throw new Error(`--dry-run must not run git: ${args.join(' ')}`);
          return run(baseResponses)(cmd, args);
        },
      });
      const line = result.lines.find((l) => l.includes('drift'));
      expect(line).toBe(`${MARK.info} drift check skipped under --dry-run: it runs git fetch ${BASE_REMOTE} develop, which writes to this clone`);
      expect(result.lines.some((l) => l.includes('behind'))).toBe(false);
    });

    it('asks the base nothing, and prints nothing about it, where no engine.commit is recorded', async () => {
      writeFileSync(
        join(product, 'project.json'),
        JSON.stringify({ name: 'base', apps: { api: { path: 'apps/api', toolchain: 'python', reads: ['apps/api'] } } }),
      );
      const result = await runCheck({
        root: product,
        repo: 'octo/proj',
        skipVerify: true,
        runIdentityTest: identityOk,
        run: async (cmd, args) => {
          if (cmd === 'git') throw new Error(`no engine.commit, so git must not be run: ${args.join(' ')}`);
          return run(baseResponses)(cmd, args);
        },
      });
      expect(result.lines.some((l) => l.includes('behind') || l.includes('up to date') || l.startsWith(MARK.info))).toBe(false);
    });
  });

  it("reads project.json and README.md from the given root, not this repository's own", async () => {
    // This is what create()'s own guard depends on: it must be possible to
    // point runCheck at a clone without it quietly grading this checkout
    // instead. A root with a deployed app and a real VERCEL_TOKEN expiry,
    // where this repository's own project.json and README have neither,
    // proves the read actually moved.
    const root = mkdtempSync(join(tmpdir(), 'setup-root-'));
    try {
      writeFileSync(
        join(root, 'project.json'),
        JSON.stringify({
          name: 'acme',
          apps: {
            web: {
              path: 'apps/web',
              toolchain: 'node',
              reads: ['apps/web'],
              deploy: { provider: 'vercel', team: 't', project: 'p', url: 'https://acme.example', commitEndpoint: '/health' },
            },
          },
        }),
      );
      writeFileSync(join(root, 'README.md'), '| VERCEL_TOKEN | expires 2027-01-01 |\n');

      const result = await runCheck({
        run: run({
          ...baseResponses,
          'gh secret list': {
            status: 0,
            stdout: JSON.stringify([{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }, { name: 'VERCEL_TOKEN' }]),
            stderr: '',
          },
        }),
        root,
        repo: 'octo/proj',
        skipVerify: true,
        runIdentityTest: identityOk,
        fetchUrl: async () => ({ status: 200, text: async () => 'hello' }) as unknown as Response,
      });

      expect(result.lines.some((l) => l.includes('web:') && l.includes('acme.example'))).toBe(true);
      expect(result.lines.some((l) => l.includes("VERCEL_TOKEN's expiry is recorded"))).toBe(true);
      expect(result.lines.some((l) => l.includes('no app has a deploy block'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureEmptyTarget', () => {
  function run(responses: Record<string, { status: number; stdout: string; stderr: string }>): Run {
    return async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      for (const [prefix, result] of Object.entries(responses)) {
        if (key.startsWith(prefix)) return result;
      }
      throw new Error(`unexpected call: ${key}`);
    };
  }

  it('reports "does not exist" when the repository lookup fails, without checking emptiness', async () => {
    const calls: string[] = [];
    const result = await ensureEmptyTarget({
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
      },
      target: 'o/n',
    });
    expect(result).toEqual({ exists: false });
    expect(calls).toHaveLength(1); // only the existence check; no branches call
  });

  it('treats only a 404 as "does not exist": a 403, a rate limit or a network error throws', async () => {
    for (const stderr of ['HTTP 403: Forbidden', 'API rate limit exceeded (HTTP 429)', 'dial tcp: connection refused']) {
      await expect(
        ensureEmptyTarget({ run: async () => ({ status: 1, stdout: '', stderr }), target: 'o/n' }),
      ).rejects.toThrow(/repos\/o\/n failed/);
    }
  });

  it('treats GitHub\'s 409 "Git Repository is empty." as empty', async () => {
    const result = await ensureEmptyTarget({
      run: run({
        'gh api repos/o/n --jq .name': { status: 0, stdout: 'n', stderr: '' },
        'gh api repos/o/n/branches': {
          status: 1,
          stdout: '{"message":"Git Repository is empty."}',
          stderr: 'gh: Git Repository is empty. (HTTP 409)',
        },
      }),
      target: 'o/n',
    });
    expect(result).toEqual({ exists: true });
  });

  it('keeps every other 409, and every other failure of the emptiness check, fail-closed', async () => {
    for (const stderr of ['gh: Conflict (HTTP 409)', 'gh: Git Repository is empty.', 'HTTP 403: Forbidden']) {
      await expect(
        ensureEmptyTarget({
          run: run({
            'gh api repos/o/n --jq .name': { status: 0, stdout: 'n', stderr: '' },
            'gh api repos/o/n/branches': { status: 1, stdout: '', stderr },
          }),
          target: 'o/n',
        }),
      ).rejects.toThrow(/branches failed/);
    }
  });

  it('proceeds when the repository exists and it has no branches', async () => {
    const result = await ensureEmptyTarget({
      run: run({
        'gh api repos/o/n --jq .name': { status: 0, stdout: '{}', stderr: '' },
        'gh api repos/o/n/branches': { status: 0, stdout: '[]', stderr: '' },
      }),
      target: 'o/n',
    });
    expect(result).toEqual({ exists: true });
  });

  it('refuses an existing, non-empty repository', async () => {
    await expect(
      ensureEmptyTarget({
        run: run({
          'gh api repos/o/n --jq .name': { status: 0, stdout: '{}', stderr: '' },
          'gh api repos/o/n/branches': { status: 0, stdout: '[{"name":"develop"}]', stderr: '' },
        }),
        target: 'o/n',
      }),
    ).rejects.toThrow(/already exists and is not empty/);
  });

  it('fails closed, with gh\'s own stderr, when the emptiness check itself errors — never falling through to "assume empty"', async () => {
    await expect(
      ensureEmptyTarget({
        run: run({
          'gh api repos/o/n --jq .name': { status: 0, stdout: '{}', stderr: '' },
          'gh api repos/o/n/branches': { status: 1, stdout: '', stderr: 'API rate limit exceeded' },
        }),
        target: 'o/n',
      }),
    ).rejects.toThrow(/API rate limit exceeded/);
  });

  it('fails closed when the emptiness check returns unparseable JSON', async () => {
    await expect(
      ensureEmptyTarget({
        run: run({
          'gh api repos/o/n --jq .name': { status: 0, stdout: '{}', stderr: '' },
          'gh api repos/o/n/branches': { status: 0, stdout: 'not json', stderr: '' },
        }),
        target: 'o/n',
      }),
    ).rejects.toThrow(/unparseable JSON/);
  });
});

describe('engineDrift', () => {
  const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr: string, status = 1) => ({ status, stdout: '', stderr });

  /** A `run` that answers the three git calls, each by the sub-command it is. */
  function git(answers: { fetch?: ReturnType<typeof ok>; ancestor?: ReturnType<typeof ok>; count?: ReturnType<typeof ok> }) {
    const calls: string[] = [];
    const run: Run = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args.includes('fetch')) return answers.fetch ?? ok();
      if (args.includes('merge-base')) return answers.ancestor ?? ok();
      if (args.includes('rev-list')) return answers.count ?? ok('0\n');
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };
    return { run, calls };
  }

  it('fetches only develop from the base remote, then counts what the recorded commit lacks', async () => {
    const { run, calls } = git({ count: ok('3\n') });
    const line = await engineDrift({ run, root: '/p', commit: COMMIT });
    expect(calls).toEqual([
      `git -C /p fetch --no-tags ${BASE_REMOTE} develop`,
      `git -C /p merge-base --is-ancestor ${COMMIT} FETCH_HEAD`,
      `git -C /p rev-list --count ${COMMIT}..FETCH_HEAD`,
    ]);
    expect(line).toEqual({
      mark: MARK.info,
      text: `behind ${BASE_REMOTE} by 3 commits (engine.commit abcdef0); the sync-ai-layer skill brings them in and moves engine.commit`,
    });
  });

  it('says "1 commit" for one, and "up to date" for none', async () => {
    expect((await engineDrift({ ...git({ count: ok('1\n') }), root: '/p', commit: COMMIT })).text).toMatch(/behind boris by 1 commit \(/);
    expect(await engineDrift({ ...git({ count: ok('0\n') }), root: '/p', commit: COMMIT })).toEqual({
      mark: MARK.info,
      text: `up to date with ${BASE_REMOTE} (engine.commit abcdef0)`,
    });
  });

  it('is never an owner action, whatever it finds', async () => {
    const answers = [
      git({ count: ok('9\n') }),
      git({ fetch: fail('no such remote') }),
      git({ ancestor: fail('', 1) }),
      git({ count: fail('boom') }),
      git({ count: ok('not a number') }),
    ];
    for (const a of answers) expect((await engineDrift({ run: a.run, root: '/p', commit: COMMIT })).mark).toBe(MARK.info);
    expect(renderCheck([{ mark: MARK.info, text: 'x' }]).exitCode).toBe(0);
  });

  it('says so when the fetch fails, and does not go on to count against a stale FETCH_HEAD', async () => {
    const { run, calls } = git({ fetch: fail("fatal: 'boris' does not appear to be a git repository", 128) });
    const line = await engineDrift({ run, root: '/p', commit: COMMIT });
    expect(line.text).toMatch(/cannot be measured: git fetch boris develop failed \(fatal: 'boris' does not appear/);
    expect(calls).toHaveLength(1);
  });

  it("says the recorded commit is not in the base's develop history only when git says so (exit 1), and never counts from it", async () => {
    const { run, calls } = git({ ancestor: fail('', 1) });
    const line = await engineDrift({ run, root: '/p', commit: COMMIT });
    expect(line.text).toBe(`engine.commit abcdef0 is not in ${BASE_REMOTE}'s develop history (unpushed, or rewritten), so how far behind cannot be counted`);
    expect(calls.some((c) => c.includes('rev-list'))).toBe(false);
  });

  it('says the check failed, not that the commit is unknown, when git errors (any other exit)', async () => {
    for (const status of [128, 2, 129]) {
      const { run, calls } = git({ ancestor: fail('fatal: Not a valid commit name', status) });
      const line = await engineDrift({ run, root: '/p', commit: COMMIT });
      expect(line.mark).toBe(MARK.info);
      expect(line.text, String(status)).toMatch(/cannot be checked: git merge-base failed \(fatal: Not a valid commit name\)/);
      expect(line.text).not.toMatch(/is not in/);
      expect(calls.some((c) => c.includes('rev-list'))).toBe(false);
    }
  });

  // Timeout: spawns several git commands in a real repository (468 ms quiet); 30 s.
  it('is measured against a real repository: a base two commits ahead of the recorded one', { timeout: 30_000 }, async () => {
    // Real git, no network: a "base" with three commits stands in for boris,
    // the product records the first and fetches from it.
    const dir = mkdtempSync(join(tmpdir(), 'setup-drift-'));
    try {
      const g = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
      const base = join(dir, 'base');
      const product = join(dir, 'product');
      mkdirSync(base);
      g(base, 'init', '-q', '-b', 'develop');
      const shas: string[] = [];
      for (const n of [1, 2, 3]) {
        writeFileSync(join(base, 'f'), String(n));
        g(base, 'add', '-A');
        g(base, 'commit', '-q', '-m', `c${n}`);
        shas.push(g(base, 'rev-parse', 'HEAD'));
      }
      mkdirSync(product);
      g(product, 'init', '-q', '-b', 'develop');
      g(product, 'remote', 'add', BASE_REMOTE, base);
      const realRun: Run = async (cmd, args) => {
        try {
          return { status: 0, stdout: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
        } catch (error) {
          const e = error as { status?: number; stdout?: string; stderr?: string };
          return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
        }
      };
      expect((await engineDrift({ run: realRun, root: product, commit: shas[0]! })).text).toMatch(/^behind boris by 2 commits/);
      expect((await engineDrift({ run: realRun, root: product, commit: shas[2]! })).text).toMatch(/^up to date with boris/);
      // A commit the product has that the base's develop does not: git answers "not an ancestor" (exit 1).
      g(product, 'checkout', '-q', '-b', 'elsewhere');
      writeFileSync(join(product, 'g'), 'x');
      g(product, 'add', '-A');
      g(product, 'commit', '-q', '-m', 'local only');
      const local = g(product, 'rev-parse', 'HEAD');
      expect((await engineDrift({ run: realRun, root: product, commit: local })).text).toMatch(/is not in boris's develop history/);
      // A commit git has never heard of: git errors (exit 128), which is reported as a failed check, not as an answer.
      expect((await engineDrift({ run: realRun, root: product, commit: 'f'.repeat(40) })).text).toMatch(/cannot be checked: git merge-base failed/);
      g(product, 'remote', 'remove', BASE_REMOTE);
      expect((await engineDrift({ run: realRun, root: product, commit: shas[0]! })).text).toMatch(/cannot be measured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('npm and npx on Windows (#276)', () => {
  it('needsShell is true only for npm and npx, only on win32', () => {
    for (const cmd of ['npm', 'npx']) {
      expect(needsShell(cmd, 'win32'), cmd).toBe(true);
      expect(needsShell(cmd, 'linux'), cmd).toBe(false);
      expect(needsShell(cmd, 'darwin'), cmd).toBe(false);
    }
    for (const cmd of ['gh', 'git', 'uv', 'node']) expect(needsShell(cmd, 'win32'), cmd).toBe(false);
  });

  it('exec on win32 passes ONE command string and shell:true to execFile, no args array (DEP0190); linux gets the array, no shell', async () => {
    const seen: unknown[][] = [];
    const execFileImpl = (...a: unknown[]) => {
      seen.push(a.slice(0, -1));
      (a[a.length - 1] as (e: null, o: string, r: string) => void)(null, '', '');
    };
    await exec('npx', ['npm@11', '--version'], { platform: 'win32', execFileImpl });
    await exec('npx', ['npm@11', '--version'], { platform: 'linux', execFileImpl });
    await exec('git', ['--version'], { platform: 'win32', execFileImpl });
    const opt = (shell: boolean) => expect.objectContaining({ shell });
    expect(seen).toEqual([
      ['npx npm@11 --version', opt(true)],
      ['npx', ['npm@11', '--version'], opt(false)],
      ['git', ['--version'], opt(false)],
    ]);
  }, 10_000);

  it('spawnTool on win32 passes one command string and shell:true, no args array; linux the array and no shell', () => {
    const calls: unknown[][] = [];
    const spawnImpl = (...a: unknown[]) => {
      calls.push(a);
      return { status: 0 };
    };
    spawnTool('npm', ['run', 'verify'], { stdio: 'inherit' }, { platform: 'win32', spawnImpl });
    spawnTool('npm', ['run', 'verify'], { stdio: 'inherit' }, { platform: 'linux', spawnImpl });
    spawnTool('node', ['x'], {}, { platform: 'win32', spawnImpl });
    expect(calls).toEqual([
      ['npm run verify', { stdio: 'inherit', shell: true }],
      ['npm', ['run', 'verify'], { stdio: 'inherit', shell: false }],
      ['node', ['x'], { shell: false }],
    ]);
  });

  it('shellCommand accepts plain tokens and refuses anything a shell would interpret', () => {
    expect(shellCommand('npx', ['npm@11', '--version'])).toBe('npx npm@11 --version');
    expect(shellCommand('npm', ['run', 'a/b_c=1:2+3.x'])).toBe('npm run a/b_c=1:2+3.x');
    for (const bad of ['x & calc', 'a|b', 'a^b', '%PATH%', 'a<b', 'a>b', '"q"', "'q'", 'a;b', '', '$x', '`x`', 'a\nb']) {
      expect(() => shellCommand('npm', ['run', bad]), JSON.stringify(bad)).toThrow(/refusing/);
    }
  });

  it('on win32 a refused argument stops exec and spawnTool before anything runs; on linux no guard', async () => {
    let ran = 0;
    const execFileImpl = () => { ran++; };
    const spawnImpl = () => { ran++; return { status: 0 }; };
    await expect(exec('npx', ['npm@11', 'x & calc'], { platform: 'win32', execFileImpl })).rejects.toThrow(/refusing/);
    expect(() => spawnTool('npm', ['run', 'x & calc'], {}, { platform: 'win32', spawnImpl })).toThrow(/refusing/);
    expect(ran).toBe(0);
    spawnTool('npm', ['run', 'x & calc'], {}, { platform: 'linux', spawnImpl });
    expect(ran).toBe(1);
  }, 10_000);
});

// `create` runs from the base checkout, which has catalogue.json; a product has none (#281).
describe.skipIf(!existsSync(join(ROOT, 'catalogue.json')))('create refuses a dirty base and names the files (#280)', () => {
  const dirtyRun = (lines: string[]) => async (cmd: string, args: string[]) => {
    const isStatus = cmd === 'git' && args.includes('status');
    return { status: 0, stdout: isStatus ? lines.join('\n') + '\n' : 'ok', stderr: '' };
  };
  const attempt = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-dirty-'));
    const opts = { name: 'p', owner: 'o', dir: join(dir, 'p'), public: false, starters: [] as string[] };
    const spawn = () => ({ status: 0 });
    return create(opts, { run: dirtyRun(lines), spawn, log: () => {} }).finally(() => rmSync(dir, { recursive: true, force: true }));
  };

  it('lists the dirty paths', async () => {
    const err = await attempt([' M package-lock.json', 'M  docs/a b.md']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/uncommitted changes to tracked files/);
    expect((err as Error).message).toContain('package-lock.json');
    expect((err as Error).message).toContain('docs/a b.md');
    expect((err as Error).message).not.toMatch(/and \d+ more/);
  }, 20_000);

  it('lists at most 10, then "and N more"', async () => {
    const lines = Array.from({ length: 13 }, (_, i) => ` M f${String(i).padStart(2, '0')}.txt`);
    const err = (await attempt(lines).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('f09.txt');
    expect(err.message).not.toContain('f10.txt');
    expect(err.message).toMatch(/and 3 more/);
  }, 20_000);
});


// ---------------------------------------------------------------------------
// add (the parts that need no base; the rest is in setup-create.test.ts)
// ---------------------------------------------------------------------------

describe('parseAddArgs', () => {
  it('collects every --starter', () => {
    expect(parseAddArgs(['--starter', 'node-react', '--starter', 'python-fastapi']).starters).toEqual(['node-react', 'python-fastapi']);
  });

  it('refuses no starter, a missing value, an unknown flag, and the stripped form', () => {
    expect(() => parseAddArgs([])).toThrow(/at least one --starter/);
    expect(() => parseAddArgs(['--starter'])).toThrow(/needs a value/);
    expect(() => parseAddArgs(['--starter', '--x'])).toThrow(/needs a value/);
    expect(() => parseAddArgs(['--name', 'x'])).toThrow(/unknown flag "--name"/);
    expect(() => parseAddArgs(['node-react'])).toThrow(/node scripts\/setup\.mjs add --starter/);
  });
});
