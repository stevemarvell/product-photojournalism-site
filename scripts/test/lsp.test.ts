import { describe, expect, it } from 'vitest';
import { LANGUAGE_SERVERS, missingPackages, onPath } from '../lsp.mjs';

describe('missingPackages', () => {
  it('installs nothing when every language server is already on PATH', () => {
    expect(missingPackages(() => true)).toEqual([]);
  });

  it('installs the packages for each server that is missing', () => {
    const present = new Set(['pyright-langserver']);
    expect(missingPackages((command) => present.has(command))).toEqual([
      'typescript-language-server',
      'typescript',
    ]);
  });

  it('covers exactly the two servers the enabled plugins need', () => {
    expect(Object.keys(LANGUAGE_SERVERS)).toEqual([
      'pyright-langserver',
      'typescript-language-server',
    ]);
  });
});

describe('onPath', () => {
  it('is true when the lookup succeeds', () => {
    expect(onPath('anything', () => undefined)).toBe(true);
  });

  it('is false when the lookup throws, rather than propagating', () => {
    expect(
      onPath('anything', () => {
        throw new Error('not found');
      }),
    ).toBe(false);
  });
});
