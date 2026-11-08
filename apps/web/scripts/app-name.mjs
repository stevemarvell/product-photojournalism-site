// Substituting the project's own name into index.html at build/dev time.
//
// Kept out of vite.config.ts itself: that file pulls in 'vitest/config',
// which drags esbuild along, and esbuild cannot run inside a jsdom test
// environment ("TextEncoder().encode('') instanceof Uint8Array is
// incorrectly false"). This module has no such dependency, so a unit test
// can import it directly.
import { escapeHtml } from '../../../scripts/markdown.mjs';

/**
 * Substitutes %APP_NAME% in an HTML document with `name`, escaped the same
 * way build-docs.mjs escapes it for the docs site — `name` lands in a text
 * node (`<title>`), so an unescaped `<` or `&` would not just read oddly, it
 * would parse as markup.
 */
export function substituteAppName(html, name) {
  return html.replace(/%APP_NAME%/g, escapeHtml(name));
}
