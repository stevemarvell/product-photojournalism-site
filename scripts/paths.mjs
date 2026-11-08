// One spelling of a path, for every comparison in this repository.
//
// This lived in review-scope.mjs: a path comparison that lowercased in one
// place and not in the next let `.CLAUDE/agents/security-checker.md` skip
// both of its own reviews. The fix was a single normalisation and a test
// that asserts the helper directly, so a future comparison cannot grow its
// own.
//
// test-census.mjs then needed the same thing and began by re-deriving a
// strictly weaker copy — trim and strip `./`, but no case fold — which is
// the first step of exactly the drift the fix above closed. So it moved
// here, and both import it. review-scope.mjs re-exports it, because its
// public surface and the test that guards it are what that fix bought.

/**
 * Trim, drop a leading `./`, and fold case.
 *
 * Case folding happens here and nowhere else, which is the point.
 */
export function canonical(path) {
  return String(path).trim().replace(/^\.\//, '').toLowerCase();
}
