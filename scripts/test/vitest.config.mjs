// The AI layer's own test suite: hooks, the triage and drive-pr helpers, the
// census, contention, the Vercel scripts, the manifest. It lives outside
// every app, so deleting an application never deletes the AI layer's own
// tests along with it. Plain Node, not jsdom: nothing here touches a DOM.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
