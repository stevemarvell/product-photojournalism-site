import { describe, expect, it } from 'vitest';
import {
  LABEL_PAGE_SIZE,
  MAX_LABEL_PAGES,
  apply,
  gh,
  listLabels,
  loadManifest,
  main,
  plan,
  validate,
  writeArgs,
  type Label,
  type Run,
} from '../labels.mjs';

const label = (name: string, color = 'b60205', description = 'd'): Label => ({ name, color, description });

describe('the committed labels.json', () => {
  it('loads and validates', () => {
    const manifest = loadManifest();
    expect(manifest.length).toBeGreaterThan(0);
  });

  it('carries every label the AI layer rules name', () => {
    const names = loadManifest().map((l) => l.name);
    for (const name of [
      'critical',
      'high',
      'medium',
      'human',
      'do not automate',
      'template',
      'security',
      'blocked: no paid plan',
      'postmortem',
      'aia0',
      'aia1',
      'aia2',
      'aia3',
      'aia4',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('has no duplicate names and only 6-hex colours', () => {
    const manifest = loadManifest();
    expect(new Set(manifest.map((l) => l.name)).size).toBe(manifest.length);
    for (const l of manifest) {
      expect(l.color, l.name).toMatch(/^[0-9a-f]{6}$/i);
      expect(typeof l.description, l.name).toBe('string');
    }
  });
});

describe('validate', () => {
  it('rejects a manifest that is not a non-empty array', () => {
    expect(() => validate([])).toThrow(/non-empty array/);
    expect(() => validate('nope')).toThrow(/non-empty array/);
  });

  it('rejects a repeated name', () => {
    expect(() => validate([label('critical'), label('critical')])).toThrow(/listed more than once/);
  });

  it('rejects a colour that is not 6 hex digits', () => {
    expect(() => validate([label('critical', 'red')])).toThrow(/hex/);
    expect(() => validate([label('critical', 'b6020')])).toThrow(/hex/);
  });

  it('rejects a missing description', () => {
    const bad = [{ name: 'critical', color: 'b60205' }] as unknown as Label[];
    expect(() => validate(bad)).toThrow(/description/);
  });

  it('accepts a well-formed manifest and returns it', () => {
    const manifest = [label('critical')];
    expect(validate(manifest)).toBe(manifest);
  });
});

describe('plan', () => {
  const manifest = [label('critical', 'b60205', 'Do first'), label('high', 'fbca04', 'Do next')];

  it('creates every label missing from the repository', () => {
    expect(plan(manifest, [])).toEqual([
      { ...manifest[0], action: 'create' },
      { ...manifest[1], action: 'create' },
    ]);
  });

  it('updates a label whose colour or description differs, case-insensitively on colour', () => {
    const existing = [
      { name: 'critical', color: 'B60205', description: 'Do first' },
      { name: 'high', color: '000000', description: 'Do next' },
    ];
    expect(plan(manifest, existing)).toEqual([{ ...manifest[1], action: 'update' }]);
  });

  it('leaves an identical label out of the plan entirely', () => {
    const existing = [
      { name: 'critical', color: 'b60205', description: 'Do first' },
      { name: 'high', color: 'fbca04', description: 'Do next' },
    ];
    expect(plan(manifest, existing)).toEqual([]);
  });

  it('never touches a repository label that is not in the manifest', () => {
    const existing = [
      { name: 'critical', color: 'b60205', description: 'Do first' },
      { name: 'high', color: 'fbca04', description: 'Do next' },
      { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
    ];
    const actions = plan(manifest, existing);
    expect(actions.map((a) => a.name)).not.toContain('bug');
  });
});

describe('listLabels', () => {
  const restLabel = (name: string, description: string | null = 'x') => ({ id: 1, name, color: 'd73a4a', description, default: false });

  it('parses the REST labels listing, reading a null description as empty', async () => {
    const run: Run = async () => ({
      status: 0,
      stdout: JSON.stringify([restLabel('bug'), restLabel('plain', null)]),
      stderr: '',
    });
    expect(await listLabels(run)).toEqual([
      { name: 'bug', color: 'd73a4a', description: 'x' },
      { name: 'plain', color: 'd73a4a', description: '' },
    ]);
  });

  it('reads REST, never gh label (GraphQL, refused from cloud sessions)', async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return { status: 0, stdout: '[]', stderr: '' };
    };
    await listLabels(run);
    expect(calls[0]![0]).toBe('api');
    expect(calls[0]![1]).toBe(`repos/{owner}/{repo}/labels?per_page=${LABEL_PAGE_SIZE}&page=1`);
  });

  it('puts --repo in the path when given', async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return { status: 0, stdout: '[]', stderr: '' };
    };
    await listLabels(run, 'owner/name');
    expect(calls[0]![1]).toMatch(/^repos\/owner\/name\/labels\?/);
  });

  it('follows pages until a short one', async () => {
    const full = Array.from({ length: LABEL_PAGE_SIZE }, (_, i) => restLabel(`l${i}`));
    const pages = [full, [restLabel('last')]];
    let n = 0;
    const run: Run = async () => ({ status: 0, stdout: JSON.stringify(pages[n++]), stderr: '' });
    expect(await listLabels(run)).toHaveLength(LABEL_PAGE_SIZE + 1);
    expect(n).toBe(2);
  });

  it('fails at its page ceiling rather than planning from a partial list', async () => {
    const full = Array.from({ length: LABEL_PAGE_SIZE }, (_, i) => restLabel(`l${i}`));
    let n = 0;
    const run: Run = async () => {
      n += 1;
      return { status: 0, stdout: JSON.stringify(full), stderr: '' };
    };
    await expect(listLabels(run)).rejects.toThrow(/more pages remain/);
    expect(n).toBe(MAX_LABEL_PAGES);
  });

  it('throws with the injected stderr, rather than treating empty as no labels', async () => {
    const run: Run = async () => ({ status: 1, stdout: '', stderr: 'not found (HTTP 404)' });
    await expect(listLabels(run)).rejects.toThrow(/not found \(HTTP 404\)/);
  });

  it('falls back to stdout when gh fails with nothing on stderr', async () => {
    const run: Run = async () => ({ status: 1, stdout: 'bogus flag', stderr: '' });
    await expect(listLabels(run)).rejects.toThrow(/bogus flag/);
  });
});

describe('writeArgs', () => {
  const create = { ...label('critical', 'b60205', 'Do first'), action: 'create' as const };
  const update = { ...label('do not automate', 'b60205', 'Needs: a person'), action: 'update' as const };

  it('POSTs a new label to the collection', () => {
    expect(writeArgs(create)).toEqual([
      'api', 'repos/{owner}/{repo}/labels', '-X', 'POST', '-f', 'name=critical', '-f', 'color=b60205', '-f', 'description=Do first',
    ]);
  });

  it('PATCHes an existing label by its URL-encoded name, so a name with spaces or a colon is addressed correctly', () => {
    const args = writeArgs(update, 'o/n');
    expect(args.slice(0, 4)).toEqual(['api', 'repos/o/n/labels/do%20not%20automate', '-X', 'PATCH']);
    expect(args).not.toContain('name=do not automate');
  });
});

describe('apply', () => {
  const manifest = [label('critical', 'b60205', 'Do first')];

  it('POSTs each label missing from the repository, and reports it', async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      if (args.length === 2) return { status: 0, stdout: '[]', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const lines: string[] = [];
    const actions = await apply({ run, manifest, log: (l) => lines.push(l) });
    expect(actions).toEqual([{ ...manifest[0], action: 'create' }]);
    const write = calls.find((c) => c.includes('-X'));
    expect(write).toEqual(writeArgs({ ...manifest[0]!, action: 'create' }));
    expect(lines.some((l) => l.includes('create critical'))).toBe(true);
  });

  it('PATCHes a label whose colour differs, rather than re-creating it', async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      if (args.length === 2) {
        return { status: 0, stdout: JSON.stringify([{ name: 'critical', color: '000000', description: 'Do first' }]), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    await apply({ run, manifest, log: () => {} });
    expect(calls.find((c) => c.includes('-X'))).toContain('PATCH');
  });

  it('under --dry-run, writes nothing', async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return { status: 0, stdout: '[]', stderr: '' };
    };
    const actions = await apply({ run, manifest, dryRun: true, log: () => {} });
    expect(actions).toEqual([{ ...manifest[0], action: 'create' }]);
    expect(calls.some((c) => c.includes('-X'))).toBe(false);
  });

  it('throws with the injected stderr when a write fails, naming the label', async () => {
    const run: Run = async (args) => {
      if (args.length === 2) return { status: 0, stdout: '[]', stderr: '' };
      return { status: 1, stdout: '', stderr: 'HTTP 422: already_exists' };
    };
    await expect(apply({ run, manifest, log: () => {} })).rejects.toThrow(/critical/);
    await expect(apply({ run, manifest, log: () => {} })).rejects.toThrow(/already_exists/);
  });

  it('makes no network calls of its own: everything goes through the injected run', async () => {
    let invoked = 0;
    const run: Run = async (args) => {
      invoked += 1;
      if (args.length === 2) return { status: 0, stdout: '[]', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    await apply({ run, manifest, log: () => {} });
    expect(invoked).toBeGreaterThan(0);
  });
});

describe('gh', () => {
  // Timeout: spawns the real gh binary (59 ms quiet); 15 s.
  it('reports a real failure with a non-empty stderr, for an invocation that is safe offline', { timeout: 15_000 }, async () => {
    // An unknown flag makes gh's own argument parser reject the command
    // before it would otherwise need the network, so this is deterministic
    // without talking to GitHub — and it is this suite's one real exercise
    // of the execFile wiring the mocked `run` in every other test replaces.
    const result = await gh(['api', '--bogus-flag']);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  });
});

describe('main', () => {
  it('rejects --repo followed by another flag rather than treating the flag as the repo name', async () => {
    await expect(main(['--repo', '--dry-run'])).rejects.toThrow(/usage/);
  });

  it('rejects --repo with no value at all', async () => {
    await expect(main(['--repo'])).rejects.toThrow(/usage/);
  });
});
