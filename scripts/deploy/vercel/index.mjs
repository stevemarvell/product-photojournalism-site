// What scripts/deploy/index.mjs's registry exposes for the "vercel"
// provider: the one piece of ../../smoke.mjs's freshness gate that is
// Vercel-specific. vercel-ignore.mjs and vercel-prune.mjs are invoked
// directly — as Vercel's own ignoreCommand, and by preview-prune.yml — not
// through this, because both are already provider-specific entry points
// with no generic caller to look them up by name.
export { buildIsEquivalent } from './smoke.mjs';
export { branchAlias } from './smoke.mjs';
