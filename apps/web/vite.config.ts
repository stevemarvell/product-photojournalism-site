import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { substituteAppName } from './scripts/app-name.mjs';

// apps/web/vite.config.ts -> the repository root, two directories up.
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The one place the AI layer declares what this project is called. Read here
// rather than hardcoded, so this file's own name never has to be the name of
// whatever application actually ends up running.
const { name: APP_NAME } = JSON.parse(readFileSync(join(REPO_ROOT, 'project.json'), 'utf8'));

/** Substitutes %APP_NAME% in index.html, the one place `define` cannot reach. */
function htmlAppName(): Plugin {
  return {
    name: 'html-app-name',
    transformIndexHtml(html) {
      return substituteAppName(html, APP_NAME);
    },
  };
}

export default defineConfig({
  plugins: [react(), htmlAppName()],
  define: {
    __APP_NAME__: JSON.stringify(APP_NAME),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // e2e/ belongs to Playwright; vitest's default glob would claim it.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
