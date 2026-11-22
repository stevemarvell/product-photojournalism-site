// The Vercel-specific half of ../../smoke.mjs's freshness gate: telling a
// deployment Vercel's ignoreCommand (vercel-ignore.mjs) skipped apart from
// one that is genuinely stale.
//
// A skipped build leaves an older commit live. That is fine — nothing this
// app reads changed — as long as it is *provably* fine: asked through the same
// function the ignore step itself uses (project.mjs's buildInputsChanged), so
// the two cannot disagree about what "nothing changed" means.
import { buildInputsChanged } from '../../project.mjs';

export function buildIsEquivalent({ git, project, name, deployedSha, sha }) {
  return buildInputsChanged({ git, project, name, base: deployedSha, head: sha }) === 'unchanged';
}

/** The branch alias Vercel gives `branch` of an app: `<project>-git-<branch>-<team>.vercel.app`. */
export function branchAlias({ project, team }, branch) {
  return `https://${project}-git-${branch}-${team}.vercel.app`;
}
