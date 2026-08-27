#!/bin/sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

printf 'Content-Type: application/json\r\n\r\n'

QUERY_STRING="${QUERY_STRING:-}"
REQUEST_METHOD="${REQUEST_METHOD:-GET}"

# Dev-mode logging to stderr (included in daemon error responses with --dev flag)
log_dev() {
  if [ -n "$MNDW_DEV" ]; then
    echo "[dns-lookup] $*" >&2
  fi
}

log_dev "request: method=$REQUEST_METHOD query=$QUERY_STRING"

if [ "$REQUEST_METHOD" != "GET" ]; then
  log_dev "error: METHOD_NOT_ALLOWED"
  printf '{"success":false,"error":"METHOD_NOT_ALLOWED","message":"Only GET is supported"}\n'
  exit 0
fi

hostname=""
case "$QUERY_STRING" in
  *hostname=*)
    # Keep raw query value. dns-util performs url.QueryUnescape before lookup.
    hostname=$(printf '%s' "$QUERY_STRING" | sed -n 's/.*hostname=\([^&]*\).*/\1/p')
    ;;
esac

if [ -z "$hostname" ]; then
  log_dev "error: MISSING_HOSTNAME"
  printf '{"success":false,"error":"MISSING_HOSTNAME","message":"Query parameter hostname is required"}\n'
  exit 0
fi

log_dev "lookup: hostname=$hostname"

# Test-only override; production leaves this unset and uses the packed sibling binary.
DNS_UTIL="${MNDW_LOOKUP_TEST_BINARY:-$SCRIPT_DIR/dns-util}"
log_dev "exec: $DNS_UTIL lookup $hostname"
output="$("$DNS_UTIL" lookup "$hostname" 2>&1)"
rc=$?

log_dev "result: exit_code=$rc output_length=${#output}"

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

if [ "$rc" -ne 0 ]; then
  # Parse the Go binary's JSON error code. Structured query/DNS errors pass
  # through verbatim; other failures (USAGE, LOOKUP_FAILED, etc.) are wrapped.
  error_code=$(printf '%s' "$output" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')

  log_dev "error: code=$error_code"

  if [ "$error_code" = "NXDOMAIN" ] || [ "$error_code" = "INVALID_HOSTNAME_ENCODING" ]; then
    printf '%s\n' "$output"
    exit 0
  fi

  printf '{"success":false,"error":"LOOKUP_FAILED","message":"DNS lookup failed","raw":"%s","hostname":"%s"}\n' \
    "$(printf '%s' "$output" | json_escape)" "$(printf '%s' "$hostname" | json_escape)"
  exit 0
fi

printf '%s\n' "$output"
