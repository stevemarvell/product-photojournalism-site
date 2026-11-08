// Where the e2e suite's servers live, read by playwright.config.ts.
//
// Not a *.spec.ts file, so Playwright's default testMatch leaves it alone.
import { ports } from '../../../scripts/ports.mjs';

/**
 * The servers the e2e suite starts, in the order ports() places them. The one
 * list playwright.config.ts reads, so a server's band is decided here only.
 */
export const E2E_SERVERS = ['web'] as const;

/** The web app's `vite preview` port. */
export const WEB_PORT = ports(E2E_SERVERS).web;
