---
description: Run the verification loop and report only pass or fail.
---

Run `npm run verify`. **Once.** This command reports a result; it does not
fix anything, so there is nothing to retry — see SOP 1 in `docs/sops.md`.

Report the result in one line: either `verify: pass` or `verify: fail` followed
by the failing gate and the first real error. Do not summarise what passed, and
do not paste the full output.
