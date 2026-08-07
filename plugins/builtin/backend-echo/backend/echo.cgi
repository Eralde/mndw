#!/bin/sh
# backend-echo reflector — mirrors the incoming request back as JSON
# per the mndw CGI contract. Pure POSIX sh; runs on darwin and BusyBox alike.
#
# Never exits non-zero: a bad request still yields valid JSON, and a non-200 result
# is expressed via the Status: header (a non-zero exit would become a 502 instead).

set -u

# json_escape reads stdin and escapes it as a JSON string body (backslash, quote,
# tab, CR, LF). awk slurps the whole input (RS="\0") so embedded newlines escape too.
json_escape() {
  awk 'BEGIN { RS = "\0" } {
    gsub(/\\/, "\\\\")
    gsub(/"/, "\\\"")
    gsub(/\t/, "\\t")
    gsub(/\r/, "\\r")
    gsub(/\n/, "\\n")
    printf "%s", $0
  }'
}

REQUEST_METHOD="${REQUEST_METHOD:-}"
QUERY_STRING="${QUERY_STRING:-}"
CONTENT_TYPE="${CONTENT_TYPE:-}"
CONTENT_LENGTH="${CONTENT_LENGTH:-}"
MNDW_PLUGIN_ID="${MNDW_PLUGIN_ID:-}"
MNDW_ENDPOINT_ID="${MNDW_ENDPOINT_ID:-}"

# Read the whole request body from stdin. A trailing-sentinel (printf 'x') is appended
# and then stripped so command substitution does not swallow trailing newlines — the
# body is reflected verbatim.
body=$(
  cat
  printf 'x'
)

body=${body%x}

# Optional ?status=NNN overrides the HTTP status (100-599); anything else stays 200.
status=200
case "$QUERY_STRING" in
*status=*)
  val=$(printf '%s' "$QUERY_STRING" | sed -n 's/.*status=\([0-9][0-9]*\).*/\1/p')
  if [ -n "$val" ] && [ "$val" -ge 100 ] 2>/dev/null && [ "$val" -le 599 ] 2>/dev/null; then
    status="$val"
  fi
  ;;
esac

esc_query=$(printf '%s' "$QUERY_STRING" | json_escape)
esc_ctype=$(printf '%s' "$CONTENT_TYPE" | json_escape)
# Keep a sentinel after body while awk reads it; some awk implementations trim trailing
# newlines when the record separator is NUL. Strip sentinel only after escaping.
esc_body=$(printf '%sx' "$body" | json_escape)
esc_body=${esc_body%x}

# CGI header block, blank line, then the JSON body. \r\n line endings match the
# daemon's header-separator search.
printf 'Status: %s\r\n' "$status"
printf 'Content-Type: application/json\r\n'
printf 'X-Mndw-Echo: 1\r\n'
printf '\r\n'
printf '{"method":"%s","query":"%s","contentType":"%s","contentLength":"%s","pluginId":"%s","endpointId":"%s","body":"%s"}\n' \
  "$REQUEST_METHOD" "$esc_query" "$esc_ctype" "$CONTENT_LENGTH" "$MNDW_PLUGIN_ID" "$MNDW_ENDPOINT_ID" "$esc_body"
