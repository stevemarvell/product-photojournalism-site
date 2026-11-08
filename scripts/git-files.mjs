// The files a check should look at: what git would commit, not only what it
// has committed.
//
// A check that lists files through plain `git ls-files` cannot see a new file
// until it is `git add`ed. `npm run verify` is run before the first commit, so
// it passed locally on a file CI then failed (#257). This lists tracked files
// plus new, non-ignored ones: the set CI sees once the work is committed.
import { execFileSync } from 'node:child_process';

/**
 * Tracked files plus untracked, non-ignored files under `cwd`, as repo-relative
 * paths. Not for comparing commits: that stays on `git ls-tree` of a ref.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function worktreeFiles(cwd) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}
