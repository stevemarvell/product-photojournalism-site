// The registry a deploy provider's name resolves to its functions through.
//
// An app's `deploy.provider` in project.json names one of these. Generic,
// multi-provider code — today that is only scripts/smoke.mjs's freshness
// gate — looks the provider up here rather than hardcoding one; it never
// imports a provider's module directly. scripts/deploy/vercel/vercel-ignore.mjs
// and vercel-prune.mjs are different: both are provider-specific entry
// points invoked directly (Vercel's own ignoreCommand, and
// .github/workflows/preview-prune.yml), with no generic caller that would
// need to find them by name.
import * as vercel from './vercel/index.mjs';

export const PROVIDERS = { vercel };

/** The named provider's functions. Throws on a name nothing registers — project.mjs's
 * own validation should already have refused this project.json before anything gets here. */
export function provider(name) {
  const found = PROVIDERS[name];
  if (!found) throw new Error(`unknown deploy provider "${name}"`);
  return found;
}
