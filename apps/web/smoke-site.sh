#!/usr/bin/env bash
# This app's own post-deploy checks of the real site, run by smoke-deployed.sh
# after the engine's smoke.sh: the public list through the site's /api rewrite,
# the bundle being this product's, and sign-in being reachable. Takes $WEB from
# the environment. Kept apart from smoke.sh, which is the engine's (and is run
# by scripts/test/smoke.test.ts against a server that has no API).
# SMOKE_SITE_ATTEMPTS / SMOKE_SITE_INTERVAL shorten the 30 x 15s defaults in tests.
set -e
: "${WEB:?WEB is not set}"
ATTEMPTS="${SMOKE_SITE_ATTEMPTS:-30}"
INTERVAL="${SMOKE_SITE_INTERVAL:-15}"
# Shipped in the public entry chunk (a class name on the home page, in PublicSite.tsx),
# not visible wording the owner may edit.
MARKER='public-home-body'

public_list() (
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if body=$(curl -fsS --max-time 30 "$WEB/api/public/pieces" 2>/dev/null) \
      && printf '%s' "$body" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.exit(Array.isArray(JSON.parse(s))?0:1)}catch{process.exit(1)}})"; then
      echo "attempt $attempt: public list answered through /api"; exit 0
    fi
    echo "attempt $attempt: no JSON array from $WEB/api/public/pieces"
    sleep "$INTERVAL"
  done
  echo "the public list never answered through /api" >&2
  exit 1
)

product_bundle() (
  for attempt in $(seq 1 "$ATTEMPTS"); do
    page=$(curl -fsS --max-time 30 "$WEB" || true)
    bundle=$(printf '%s' "$page" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
    echo "attempt $attempt: bundle=$bundle"
    if [ -n "$bundle" ] && curl -fsS --max-time 30 "$WEB$bundle" | grep -qF "$MARKER"; then
      echo "bundle is this product's"; exit 0
    fi
    sleep "$INTERVAL"
  done
  echo "the web bundle never carried the public site ($MARKER)" >&2
  exit 1
)

sign_in_reachable() (
  for attempt in $(seq 1 "$ATTEMPTS"); do
    body=$(curl -fsS --max-time 30 "$WEB/api/auth/me" 2>/dev/null || true)
    if printf '%s' "$body" | grep -q '"signedIn":false'; then
      echo "attempt $attempt: /api/auth/me answers signed out"; exit 0
    fi
    echo "attempt $attempt: /api/auth/me said: $body"
    sleep "$INTERVAL"
  done
  echo "/api/auth/me never answered signedIn false" >&2
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

check 'the public list answers through /api' public_list
check "the bundle is this product's" product_bundle
check 'sign-in is reachable' sign_in_reachable
