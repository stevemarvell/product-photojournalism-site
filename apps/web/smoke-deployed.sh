#!/usr/bin/env bash
# The web app's post-deploy checks as project.json names them: the engine's
# smoke.sh (bundle, docs), then this app's own smoke-site.sh and smoke-headers.sh. Both take the
# URLs from the environment as scripts/smoke.mjs passes them ($WEB). Kept apart
# so an engine sync of smoke.sh cannot drop the header check.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/smoke.sh"
bash "$here/smoke-site.sh"
bash "$here/smoke-headers.sh"
