---
description: Verify, commit, and open a pull request for the current work.
---

Ship the current working-tree changes:

1. Run `npm run verify:changed` (the checks for what this branch changed; CI
   runs the full `npm run verify`). If it fails, fix it and run it again — **at most
   three attempts**. On the third failure stop and report what you tried and
   what is still red, rather than attempting a fourth (SOP 1 in
   `docs/sops.md`). Do not continue to step 2 while it is red.
2. Branch off `develop` if not already on a feature branch.
3. Commit. The subject is imperative and under 72 characters; the body says
   *why* the change exists, not what it does.
4. Push and open a PR against `develop` with `create_pull_request` (the
   GitHub MCP tool). The fallback is `gh api -X POST
   repos/{owner}/{repo}/pulls -f title=… -F body=@<file> -f head=<branch> -f
   base=develop`. Not `gh pr create`: it is GraphQL, which Claude Code cloud
   sessions refuse (#225). The body carries a "Decisions made" list: anything
   decided rather than stopped for, with the reason (`docs/sops.md` SOP 6).
5. Report the PR URL. Merge once CI is green (`merge_pull_request`, or `gh
   api -X PUT repos/{owner}/{repo}/pulls/<n>/merge -f merge_method=squash`);
   stop only for work nobody can get back, money, or anything reaching a
   third party (`docs/sops.md` SOP 6); decide everything else and add any further
   decision to that list.

$ARGUMENTS
