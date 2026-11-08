#!/usr/bin/env bash
# The API's own post-deploy checks, run by scripts/smoke.mjs after the API's
# commit-freshness gate has passed. Every deployed app's URL is in the
# environment under its project.json name, upper-cased: $API, $WEB.
#
# Each check is a subshell function, so an `exit` inside one ends that check
# only, not the whole script.
# `set -e` and nothing more, deliberately not pipefail: `printf "$page" | grep
# -q …` has grep exit at its first match, printf dies of SIGPIPE writing the
# rest of a large page, and under pipefail that 141 turns a match into a
# failure. scripts/test/smoke.test.ts guards against that regression.
set -e
: "${API:?API is not set}"

healthy() (
  # The API is a Vercel serverless function, so the first request after an
  # idle period is a cold start.
  for attempt in $(seq 1 30); do
    body=$(curl -fsS --max-time 30 "$API/health" || true)
    echo "attempt $attempt: $body"
    case "$body" in *'"ok":true'*) echo "API ok"; exit 0;; esac
    sleep 15
  done
  echo "API never reported ok" >&2
  exit 1
)

schema_withheld() (
  # Swagger UI, ReDoc and the OpenAPI document are development-only
  # (api.main); production must answer 404 for all three.
  for attempt in $(seq 1 30); do
    open_paths=''
    for path in /docs /redoc /openapi.json; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API$path" || echo 000)
      [ "$code" = 404 ] || open_paths="$open_paths $path=$code"
    done
    if [ -z "$open_paths" ]; then
      echo "attempt $attempt: /docs, /redoc and /openapi.json all 404"
      exit 0
    fi
    echo "attempt $attempt: schema surface still answering:$open_paths"
    sleep 15
  done
  echo "the API never stopped serving /docs, /redoc and /openapi.json" >&2
  exit 1
)

CURRENT=setup
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "::endgroup::"; echo "FAILED: $CURRENT" >&2; fi' EXIT
check() {
  CURRENT=$1
  echo "::group::$1"
  "$2"
  echo "::endgroup::"
}

check 'the API reports ok' healthy
check 'the API withholds its OpenAPI schema' schema_withheld
