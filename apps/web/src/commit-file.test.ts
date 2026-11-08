import { describe, expect, it } from 'vitest';
import { commitFile, commitJson } from '../scripts/commit-file.mjs';

describe('version.json', () => {
  it('reports the commit Vercel built from', () => {
    expect(JSON.parse(commitJson({ VERCEL_GIT_COMMIT_SHA: 'abc123' }))).toEqual({ commit: 'abc123' });
  });

  it('reports null where there is no commit, rather than failing the build', () => {
    expect(JSON.parse(commitJson({}))).toEqual({ commit: null });
  });

  it('is emitted into the bundle as version.json', () => {
    const emitted: { fileName: string; source: string }[] = [];
    const plugin = commitFile({ VERCEL_GIT_COMMIT_SHA: 'abc123' });
    plugin.generateBundle.call({
      emitFile: (f) => {
        emitted.push(f);
      },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe('version.json');
    expect(JSON.parse(emitted[0].source)).toEqual({ commit: 'abc123' });
  });
});
