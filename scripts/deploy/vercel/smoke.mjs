// The Vercel-specific half of ../../smoke.mjs's freshness gate: telling a
// deployment Vercel's ignoreCommand (vercel-ignore.mjs) skipped apart from
// one that is genuinely stale.
//
// A skipped build leaves an older commit live. That is fine — nothing this
// app reads changed — as long as it is *provably* fine: diffed against the
// same pathspecs the ignore step itself used (project.mjs's buildPathspecs),
// so the two cannot disagree about what "nothing changed" means.
export function buildIsEquivalent({ git, pathspecs, deployedSha, sha }) {
  return git(['diff', '--quiet', deployedSha, sha, '--', ...pathspecs]).status === 0;
}
