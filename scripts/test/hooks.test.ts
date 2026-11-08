import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixCommands, runFixes, ROOT as FORMAT_ROOT } from '../../.claude/hooks/format-edited.mjs';
import { ROOT as VERIFY_ROOT } from '../../.claude/hooks/verify-on-stop.mjs';
import { decide, filterCommand } from '../../.claude/hooks/filter-verbose.mjs';
import { apps, loadProject, type Project } from '../project.mjs';
import {
  clearAdvice,
  CLEAR_AT_PERCENT,
  COLD_CACHE_CLEAR_AT_PERCENT,
  render,
} from '../../.claude/statusline.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// A filename carrying every shell metacharacter this hook must never act on:
// backticks and $(...) run command substitution under sh, a bare quote would
// break out of a quoted string, the semicolon would end a command, and the
// space would split an unquoted argument in two.
const MALICIOUS_FILENAME = 'a`touch pwned`$(touch pwned2);"x\' y.py';

// Two Python apps and a node one, declared the way project.json declares
// them. The routing is tested against this, not the live manifest, so it
// holds whatever the application is.
const FIXTURE: Project = {
  name: 'thing',
  apps: {
    svc: { path: 'apps/svc', toolchain: 'python', reads: ['apps/svc'] },
    tool: { path: 'apps/tool', toolchain: 'python', reads: ['apps/tool'] },
    ui: { path: 'apps/ui', toolchain: 'node', reads: ['apps/ui'] },
  },
};

describe('hook roots', () => {
  // A hook fires with whatever working directory the session is in. Both
  // scripts used relative paths and failed with "Cannot find module" from any
  // subdirectory.
  // Timeout: spawns node twice (73 ms quiet); 15 s.
  it('resolve the repository root independently of the working directory', { timeout: 15_000 }, () => {
    expect(VERIFY_ROOT).toBe(REPO_ROOT);
    expect(FORMAT_ROOT).toBe(REPO_ROOT);
    // This suite runs from the repository root, so the in-process check
    // above does not prove anything about cwd on its own. Import each hook
    // fresh in a process started somewhere else.
    for (const hook of ['verify-on-stop.mjs', 'format-edited.mjs']) {
      const url = pathToFileURL(join(REPO_ROOT, '.claude', 'hooks', hook)).href;
      const root = execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(url)}).then((m) => process.stdout.write(m.ROOT))`], {
        cwd: tmpdir(),
        encoding: 'utf8',
        input: '',
      });
      expect(root, hook).toBe(REPO_ROOT);
    }
  });
});

describe('fixCommands', () => {
  it('routes Python at ruff, in the Python app that holds the file', () => {
    const commands = fixCommands('apps/svc/src/thing.py', FIXTURE);
    const [checkCommand, formatCommand] = commands;
    if (!checkCommand || !formatCommand) throw new Error('expected two commands');
    for (const { command, args } of commands) {
      expect(command).toBe('uv');
      expect(args).toContain('--directory');
      expect(args).toContain('apps/svc');
    }
    expect(checkCommand.args).toContain('check');
    expect(formatCommand.args).toContain('format');
  });

  it('routes TypeScript and JavaScript through node running eslint directly, not npx', () => {
    for (const file of ['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.mjs']) {
      const commands = fixCommands(file);
      const [only] = commands;
      if (!only) throw new Error('expected one command');
      const { command, args } = only;
      // process.execPath (node itself) is a real binary on every platform,
      // unlike the npx/npm .cmd shims — nothing here can be a shell script.
      expect(command).toBe(process.execPath);
      expect(args[0]).toMatch(/eslint[/\\]bin[/\\]eslint\.js$/);
      expect(args).toContain('--fix');
      expect(args).toContain(file);
    }
  });

  it('runs ruff from each Python app, and not at all outside one', () => {
    const tool = fixCommands('apps/tool/src/tool.py', FIXTURE);
    expect(tool.every(({ args }) => args[args.indexOf('--directory') + 1] === 'apps/tool')).toBe(true);
    expect(tool).toHaveLength(2);
    expect(fixCommands('scripts/stray.py', FIXTURE)).toEqual([]);
    expect(fixCommands('apps/ui/stray.py', FIXTURE)).toEqual([]);
  });

  it('leaves anything else alone', () => {
    for (const file of ['README.md', 'data/family.json', 'styles.css', 'noext']) {
      expect(fixCommands(file)).toEqual([]);
    }
  });

  it('carries a path with spaces, quotes, and shell metacharacters through as one untouched argv element', () => {
    for (const file of ['some dir/file.ts', `apps/svc/${MALICIOUS_FILENAME}`]) {
      const commands = fixCommands(file, FIXTURE);
      // Otherwise the loop below checks nothing.
      expect(commands.length, file).toBeGreaterThan(0);
      for (const { args } of commands) {
        // The whole point of an argv array over a shell string: filePath
        // shows up as exactly one element, never split, escaped, or
        // interpolated into a larger string.
        expect(args).toContain(file);
        expect(args.filter((a) => a === file)).toHaveLength(1);
      }
    }
  });
});

describe('runFixes', () => {
  it('hands the path to exec as a literal argv element, never as part of a larger string', () => {
    const calls: Array<[string, string[], unknown]> = [];
    // Inside a Python app, so the ruff route is actually taken (project.json).
    const malicious = `apps/svc/${MALICIOUS_FILENAME}`;
    runFixes(malicious, { exec: (command, args, options) => calls.push([command, args, options]), project: FIXTURE });

    expect(calls.length).toBeGreaterThan(0);
    for (const [command, args, options] of calls) {
      expect(typeof command).toBe('string');
      expect(Array.isArray(args)).toBe(true);
      // The malicious string appears as its own array element — never
      // concatenated into a larger string that something else would parse.
      expect(args).toContain(malicious);
      expect(args.some((a) => a !== malicious && String(a).includes(malicious))).toBe(
        false,
      );
      // execFileSync only ever spawns a shell if told to; this hook never
      // asks for one.
      expect((options as { shell?: unknown } | undefined)?.shell).not.toBe(true);
    }
  });

  // This is the exploit itself, run for real with no mocking: if runFixes
  // ever built a shell command line out of this filename, `touch` would
  // create these marker files. It cannot, because execFileSync never
  // consults a shell — proving the vulnerability class is actually closed,
  // not just that our code calls the right-sounding API.
  // Timeout: runs `uv run ruff` for real: 6.3 s on a cold uv cache, 90 ms warm; the cold cost is uv resolving its environment, not the hook; 60 s.
  it('does not execute shell metacharacters embedded in a crafted .py filename', { timeout: 60_000 }, () => {
    const markerA = join(tmpdir(), `ai-layer-hook-test-pwned-${process.pid}-a`);
    const markerB = join(tmpdir(), `ai-layer-hook-test-pwned-${process.pid}-b`);
    // Inside a real Python app — whichever project.json declares first — so
    // ruff really is invoked with it. Outside every app the route is empty
    // and this would prove nothing. A product with no Python app (an
    // engine-only one, say) has none to use, so a declared one stands in: the
    // routing and the argv are the same, though `uv` has no such directory.
    const real = apps(loadProject(), 'python')[0];
    const stand: Project = { name: 't', apps: { svc: { path: 'apps/svc', toolchain: 'python', reads: ['apps/svc'] } } };
    const project = real ? loadProject() : stand;
    const [, pythonApp] = real ?? apps(stand, 'python')[0]!;
    const malicious = `${pythonApp.path}/a\`touch ${markerA}\`$(touch ${markerB}).py`;
    expect(fixCommands(malicious, project)).toHaveLength(2);

    expect(() => runFixes(malicious, { project })).not.toThrow();

    expect(existsSync(markerA)).toBe(false);
    expect(existsSync(markerB)).toBe(false);
  });

  // Same proof for the TypeScript/eslint route, which is the one that used
  // to go through the npx .cmd shim.
  // Timeout: runs `npx eslint` for real (204 ms quiet); 15 s.
  it('does not execute shell metacharacters embedded in a crafted .ts filename', { timeout: 15_000 }, () => {
    const marker = join(tmpdir(), `ai-layer-hook-test-pwned-${process.pid}-c`);
    const malicious = `a\`touch ${marker}\`$(touch ${marker}).ts`;

    expect(() => runFixes(malicious)).not.toThrow();

    expect(existsSync(marker)).toBe(false);
  });
});

describe('filterCommand', () => {
  it('shrinks the command whose output is worst, a CI log', () => {
    const result = filterCommand('gh run view 123 --log-failed');
    expect(result?.name).toBe('gh-run-log');
    expect(result?.command).toContain('grep');
    expect(result?.command).toMatch(/head -\d+$/);
  });

  it('keeps context after a match, not just the matching line', () => {
    // A filter that shows "error" and hides the reason costs a re-run, which
    // is more than the filter saved.
    for (const command of ['gh run view 1 --log', 'npm run verify']) {
      expect(filterCommand(command)?.command).toContain('-A');
    }
  });

  it('leaves a command that already pipes or redirects alone', () => {
    // The caller has said what they want; wrapping it would fight them.
    for (const command of [
      'gh run view 123 --log | grep something',
      'npm run verify > out.txt',
      'npm audit && echo done',
      'npm run verify; ls',
    ]) {
      expect(filterCommand(command), command).toBeNull();
    }
  });

  it('passes through anything not on the list', () => {
    for (const command of ['git status', 'ls -la', 'npm run dev', 'gh pr list']) {
      expect(filterCommand(command), command).toBeNull();
    }
  });

  it('does not fire on gh run view without a log flag', () => {
    // That form prints a short step list, which is the thing worth reading.
    expect(filterCommand('gh run view 123')).toBeNull();
  });

  it('survives input that is not a command', () => {
    for (const bad of [undefined, null, 42, '', '   ']) {
      expect(filterCommand(bad as unknown as string)).toBeNull();
    }
  });
});

describe('decide', () => {
  it('rewrites a Bash command in the shape a PreToolUse hook must emit', () => {
    const output = decide({
      tool_name: 'Bash',
      tool_input: { command: 'gh run view 9 --log', description: 'read the log' },
    }) as {
      hookSpecificOutput?: {
        hookEventName: string;
        permissionDecision: string;
        updatedInput: { command: string; description: string };
      };
    };

    expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(output.hookSpecificOutput?.updatedInput.command).toContain('grep');
    // The rest of the input has to survive, or the tool call loses fields.
    expect(output.hookSpecificOutput?.updatedInput.description).toBe('read the log');
  });

  it('has no opinion about tools that are not Bash', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: 'x' } })).toEqual({});
  });

  it('has no opinion about a malformed payload', () => {
    // A hook that cannot read its input must never block the tool call.
    for (const bad of [null, undefined, {}, { tool_name: 'Bash' }]) {
      expect(decide(bad)).toEqual({});
    }
  });
});

describe('clearAdvice', () => {
  it('says nothing while the conversation is small', () => {
    expect(clearAdvice({ contextPercent: 10, cacheWarm: true })).toBeNull();
  });

  it('nudges once the context is large enough to be worth re-sending', () => {
    expect(clearAdvice({ contextPercent: CLEAR_AT_PERCENT, cacheWarm: true })).toBe(
      '/clear between tasks',
    );
  });

  it('nudges sooner when the cache is cold', () => {
    // Cold plus large is the most expensive single message available: the next
    // turn reprocesses the whole conversation at the uncached rate.
    const cold = clearAdvice({ contextPercent: COLD_CACHE_CLEAR_AT_PERCENT, cacheWarm: false });
    expect(cold).toContain('cache cold');
    expect(clearAdvice({ contextPercent: COLD_CACHE_CLEAR_AT_PERCENT, cacheWarm: true })).toBeNull();
  });

  it('says nothing when the context is unknown', () => {
    expect(clearAdvice({ contextPercent: null, cacheWarm: false })).toBeNull();
  });
});

describe('statusline render', () => {
  const payload = {
    model: { display_name: 'Opus' },
    workspace: { git_worktree: 'develop' },
    context_window: { used_percentage: 61 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 78 } },
    prompt_cache: { warm: true },
  };

  it('shows the three numbers that answer different questions', () => {
    const line = render(payload);
    expect(line).toContain('Opus · develop');
    expect(line).toContain('61%');
    expect(line).toContain('5h 12%');
    expect(line).toContain('wk 78%');
    expect(line).toContain('/clear');
  });

  it('stays quiet about the cache while it is warm', () => {
    expect(render(payload)).not.toContain('cache cold');
  });

  it('mentions a cold cache once, not twice', () => {
    // The advice sentence explains it; a separate cell would just repeat it.
    const line = render({ ...payload, prompt_cache: { warm: false } });
    expect(line).toContain('cache cold');
    expect(line.match(/cache cold/g)).toHaveLength(1);
  });

  it('still flags a cold cache when the context is too small to advise on', () => {
    const line = render({
      ...payload,
      context_window: { used_percentage: 5 },
      prompt_cache: { warm: false },
    });
    expect(line).toContain('cache cold');
    expect(line).not.toContain('⚠');
  });

  it('degrades to the model name rather than throwing', () => {
    // A status line that throws leaves the bar blank and says nothing at all.
    for (const bad of [null, undefined, {}, 'nonsense', 42]) {
      expect(() => render(bad)).not.toThrow();
    }
    expect(render({})).toBe('claude');
  });
});
