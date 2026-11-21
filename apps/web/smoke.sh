#!/usr/bin/env bash
# The web app's own post-deploy checks, run by scripts/smoke.mjs after the
# web app's commit-freshness gate has passed. Every deployed app's URL is in
# the environment under its project.json name, upper-cased: $API, $WEB.
# Nothing here calls the API, so the API's own checks cannot starve these.
#
# Each check is a subshell function, so an `exit` inside one ends that check
# only, not the whole script.
# `set -e` and nothing more, deliberately not pipefail: `printf "$page" | grep
# -q …` has grep exit at its first match, printf dies of SIGPIPE writing the
# rest of a large page, and under pipefail that 141 turns a match into a
# failure. scripts/test/smoke.test.ts guards against that regression.
set -e
: "${WEB:?WEB is not set}"

current_bundle() (
  for attempt in $(seq 1 30); do
    page=$(curl -fsS --max-time 30 "$WEB" || true)
    bundle=$(printf '%s' "$page" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
    echo "attempt $attempt: bundle=$bundle"
    if [ -n "$bundle" ] && curl -fsS --max-time 30 "$WEB$bundle" | grep -q 'No application here yet'; then
      echo "web ok"; exit 0
    fi
    sleep 15
  done
  echo "web never served the shell's bundle" >&2
  exit 1
)

# The pages the docs build publishes depend on which sources the repository
# holds: docs/adoption.md and the root index.html are the base's own and a
# product built from the starter has neither (build-docs.mjs skips them). So
# the expectation is not a list written here. `build-docs.mjs --list` prints
# what a build of this checkout publishes, one `page<TAB>text` line each, and
# this checks that every one is served and carries the heading its own source
# gives it. Smoke runs in a checkout of the commit it is checking, and the
# freshness gate has already confirmed the deployment's inputs match it.
BUILD_DOCS="$(dirname "$0")/scripts/build-docs.mjs"

docs_served() (
  plan=$(node "$BUILD_DOCS" --list) || { echo "could not list the docs pages to expect" >&2; exit 1; }
  # A floor, as e2e/docs.spec.ts has: the engine gives every project
  # docs/sops.md and the generator docs/data-governance.md, so a plan without
  # them, or an empty one, is a broken listing and not a repository with less
  # to publish. Without it an empty plan would pass by checking nothing.
  for required in sops.html data-governance.html; do
    printf '%s\n' "$plan" | grep -q "^$required	" \
      || { echo "the docs plan does not include $required:" >&2; echo "$plan" >&2; exit 1; }
  done
  echo "expecting: $(printf '%s\n' "$plan" | cut -f1 | tr '\n' ' ')"

  # These pages are built by a prebuild step, so a broken build shows up as
  # missing documentation rather than as a failed deploy. Retried for the
  # same reason as the API's manual: a page can lag the deployment. The
  # 30 attempts, 15s apart, are the defaults; smoke.test.ts shortens them so
  # a missing page fails in a moment.
  for attempt in $(seq 1 "${SMOKE_DOCS_ATTEMPTS:-30}"); do
    missing=''
    curl -fsS --max-time 30 -o /dev/null "$WEB/docs/" || missing=' /docs/'
    while IFS=$'\t' read -r file _; do
      curl -fsS --max-time 30 -o /dev/null "$WEB/docs/$file" || missing="$missing /docs/$file"
    done <<< "$plan"
    if [ -z "$missing" ]; then
      echo "attempt $attempt: every doc page served"
      while IFS=$'\t' read -r file expected; do
        # No listed page goes unchecked: an empty expectation is an error.
        [ -n "$expected" ] || { echo "$file has nothing to check it by" >&2; exit 1; }
        body=$(curl -fsS --max-time 30 "$WEB/docs/$file")
        printf '%s' "$body" | grep -qF -- "$expected" \
          || { echo "$file did not render its heading: no $expected" >&2; exit 1; }
        case "$file" in step-0.html) ;; *)
          printf '%s' "$body" | grep -q '<h1' \
            || { echo "$file has no rendered <h1>" >&2; exit 1; } ;;
        esac
      done <<< "$plan"
      exit 0
    fi
    echo "attempt $attempt: missing$missing"
    sleep "${SMOKE_DOCS_INTERVAL:-15}"
  done
  echo "the web deployment never served the docs" >&2
  exit 1
)

# What Vercel actually serves, not what vercel.json says: the five security
# headers on the document pages, from the constant vercel.json is tested
# against (security-headers.mjs, in the checkout this runs in), and the API's
# own CSP, not the web one, behind the /api rewrite.
SECURITY_HEADERS_MJS="$(cd "$(dirname "$0")" && pwd)/security-headers.mjs"

header_value() {
  curl -sS --max-time 30 -I "$1" | tr -d '\r' \
    | awk -v h="$2" '{ i = index($0, ":"); if (i && tolower(substr($0, 1, i - 1)) == tolower(h)) { v = substr($0, i + 1); sub(/^ +/, "", v); print v; exit } }'
}

headers_served() (
  expected=$(SECURITY_HEADERS_MJS="$SECURITY_HEADERS_MJS" node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    const { SECURITY_HEADERS } = await import(pathToFileURL(process.env.SECURITY_HEADERS_MJS).href);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) console.log(k + '\t' + v);
  ") || { echo "could not read the expected headers from $SECURITY_HEADERS_MJS" >&2; exit 1; }
  # A floor, as docs_served has: an empty listing would check nothing.
  [ "$(printf '%s\n' "$expected" | wc -l)" -ge 5 ] || { echo "expected fewer than five headers: $expected" >&2; exit 1; }

  for path in / /editor; do
    while IFS=$'\t' read -r name want; do
      got=$(header_value "$WEB$path" "$name")
      [ "$got" = "$want" ] \
        || { echo "$WEB$path: $name is '$got', expected '$want'" >&2; exit 1; }
    done <<< "$expected"
    echo "$path carries the five headers"
  done

  web_csp=$(printf '%s\n' "$expected" | awk -F'\t' '$1 == "Content-Security-Policy" { print $2 }')
  api_csp=$(header_value "$WEB/api/health" Content-Security-Policy)
  case "$api_csp" in
    "default-src 'none'"*) ;;
    *) echo "$WEB/api/health CSP is '$api_csp', expected the API's default-src 'none'" >&2; exit 1 ;;
  esac
  [ "$api_csp" != "$web_csp" ] || { echo "$WEB/api/health carries the web CSP" >&2; exit 1; }
  echo "/api/health keeps the API's own CSP"
)

# Run each check plainly, not inside `if`: a condition switches `set -e` off
# for everything it calls, and these bodies were written for a step shell
# where a failing command ends the step. On failure set -e ends the script
# and the trap names the check that did it.
CURRENT=setup
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "::endgroup::"; echo "FAILED: $CURRENT" >&2; fi' EXIT
check() {
  CURRENT=$1
  echo "::group::$1"
  "$2"
  echo "::endgroup::"
}

check 'the web app serves the current bundle' current_bundle
check 'the web deployment serves the docs' docs_served
check 'the web deployment sends its security headers' headers_served
