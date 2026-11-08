import { describe, expect, it } from 'vitest';
import { substituteAppName } from '../scripts/app-name.mjs';

describe('substituteAppName', () => {
  it('substitutes the placeholder with the given name', () => {
    expect(substituteAppName('<title>%APP_NAME%</title>', 'stand-in-app')).toBe(
      '<title>stand-in-app</title>',
    );
  });

  it('escapes the name, the same way build-docs.mjs escapes it for the docs site', () => {
    // %APP_NAME% lands inside a text node (<title>), so an unescaped "&",
    // "<" or ">" would not just read oddly — it would parse as markup.
    expect(substituteAppName('<title>%APP_NAME%</title>', 'Smith & Co <x>')).toBe(
      '<title>Smith &amp; Co &lt;x&gt;</title>',
    );
  });
});
