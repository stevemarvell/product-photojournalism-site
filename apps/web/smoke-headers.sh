#!/usr/bin/env bash
# What Vercel actually serves, not what vercel.json says: the five security
# headers on the document pages, with the values from the constant vercel.json
# is tested against (security-headers.mjs, in the checkout this runs in), and
# the API's own CSP, not the web one, behind the /api rewrite. Takes $WEB from
# the environment, as smoke.sh does. Run by smoke-deployed.sh.
set -e
: "${WEB:?WEB is not set}"
SECURITY_HEADERS_MJS="$(cd "$(dirname "$0")" && pwd)/security-headers.mjs"

header_value() {
  curl -sS --max-time 30 -I "$1" | tr -d '\r' \
    | awk -v h="$2" '{ i = index($0, ":"); if (i && tolower(substr($0, 1, i - 1)) == tolower(h)) { v = substr($0, i + 1); sub(/^ +/, "", v); print v; exit } }'
}

expected=$(SECURITY_HEADERS_MJS="$SECURITY_HEADERS_MJS" node --input-type=module -e "
  import { pathToFileURL } from 'node:url';
  const { SECURITY_HEADERS } = await import(pathToFileURL(process.env.SECURITY_HEADERS_MJS).href);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) console.log(k + '\t' + v);
") || { echo "could not read the expected headers from $SECURITY_HEADERS_MJS" >&2; exit 1; }
# A floor: an empty listing would check nothing.
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
