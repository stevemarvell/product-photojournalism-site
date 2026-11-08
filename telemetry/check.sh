#!/usr/bin/env bash
# Proves the pipeline end to end without waiting for a real Claude Code session:
# pushes one synthetic payload through the collector and asserts what comes out
# of Prometheus.
#
# Two things are worth asserting and neither is obvious from reading the config:
#
#   1. The metric names survive unsuffixed. The dashboard queries
#      claude_code_token_usage; the Prometheus exporter's default would have
#      made it claude_code_token_usage_tokens_total and every panel would read
#      "No data" with nothing visibly wrong.
#   2. The identity attributes are actually gone. They arrive on the *resource*,
#      and resource_to_telemetry_conversion turns resource attributes into
#      labels inside the exporter — after every processor has run. Scrubbing
#      datapoints alone looks right and ships user_email to disk.
#
# Usage: docker compose up -d && ./check.sh
set -euo pipefail

OTLP=${OTLP:-http://localhost:4318/v1/metrics}
PROM=${PROM:-http://localhost:9090}

now=$(( $(date +%s) * 1000000000 ))
start=$(( now - 60000000000 ))

payload=$(cat <<JSON
{"resourceMetrics":[{"resource":{"attributes":[
  {"key":"service.name","value":{"stringValue":"claude-code-check"}},
  {"key":"user.email","value":{"stringValue":"canary@example.com"}},
  {"key":"user.account_uuid","value":{"stringValue":"canary-uuid"}}]},
 "scopeMetrics":[{"scope":{"name":"com.anthropic.claude_code"},"metrics":[
  {"name":"claude_code.token.usage","unit":"tokens","sum":{"aggregationTemporality":2,"isMonotonic":true,
   "dataPoints":[{"asInt":"1000","startTimeUnixNano":"$start","timeUnixNano":"$now",
    "attributes":[{"key":"type","value":{"stringValue":"input"}}]}]}},
  {"name":"claude_code.pull_request.count","unit":"1","sum":{"aggregationTemporality":2,"isMonotonic":true,
   "dataPoints":[{"asInt":"2","startTimeUnixNano":"$start","timeUnixNano":"$now","attributes":[]}]}}]}]}]}
JSON
)

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OTLP" \
  -H 'content-type: application/json' --data-binary "$payload")
[ "$code" = "200" ] || { echo "FAIL: collector rejected the payload (HTTP $code)" >&2; exit 1; }

# Prometheus scrapes every 10s; give it two windows before believing an absence.
sleep 25

series=$(curl -s --get "$PROM/api/v1/query" \
  --data-urlencode 'query=claude_code_token_usage{service_name="claude-code-check"}')

echo "$series" | grep -q '"claude_code_token_usage"' || {
  echo "FAIL: claude_code_token_usage never reached Prometheus." >&2
  echo "      Check add_metric_suffixes: false on the prometheus exporter." >&2
  exit 1
}
echo "ok: metric name survives unsuffixed"

if echo "$series" | grep -qE 'user_email|user_account_uuid'; then
  echo "FAIL: identity labels reached Prometheus. The scrub is not working." >&2
  echo "      resource/scrub must be in the pipeline, not just attributes/scrub." >&2
  exit 1
fi
echo "ok: identity attributes scrubbed"

# The logs pipeline exists purely so the collector will accept events at all.
# Without one the OTLP receiver does not register the handler and every export
# gets a 404, which Claude Code retries for the life of the session.
logs_payload=$(cat <<JSON
{"resourceLogs":[{"resource":{"attributes":[
  {"key":"service.name","value":{"stringValue":"claude-code-check"}}]},
 "scopeLogs":[{"scope":{"name":"com.anthropic.claude_code"},"logRecords":[
  {"timeUnixNano":"$now","severityText":"INFO",
   "body":{"stringValue":"claude_code.tool_result"}}]}]}]}
JSON
)

logs_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${OTLP%/v1/metrics}/v1/logs" \
  -H 'content-type: application/json' --data-binary "$logs_payload")
[ "$logs_code" = "200" ] || {
  echo "FAIL: the collector refused an event (HTTP $logs_code)." >&2
  echo "      The logs pipeline is missing from otel-collector.yaml." >&2
  exit 1
}
echo "ok: events accepted"

echo "ok: pipeline healthy"
