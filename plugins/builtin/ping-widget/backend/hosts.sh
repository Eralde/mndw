#!/bin/sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MNDW_PLUGIN_RUNTIME_DIR="${MNDW_PLUGIN_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
export MNDW_PING_STATE_DIR="${MNDW_PING_STATE_DIR:-$SCRIPT_DIR/../.state}"

printf 'Content-Type: application/json\r\n\r\n'

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g; s/\n/\\n/g'
}

if [ "${REQUEST_METHOD:-GET}" = "GET" ]; then
  output="$("$SCRIPT_DIR/ping-util" hosts-list 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '{"success":false,"error":"PING_HOSTS_LIST_FAILED","message":"Failed to fetch hosts","raw":"%s"}\n' "$(json_escape "$output")"
    exit 0
  fi

  printf '%s\n' "$output"
  exit 0
fi

if [ "${REQUEST_METHOD:-}" = "POST" ]; then
  output="$(cat | "$SCRIPT_DIR/ping-util" hosts-update 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '{"success":false,"error":"PING_HOSTS_UPDATE_FAILED","message":"Failed to update hosts","raw":"%s"}\n' "$(json_escape "$output")"
    exit 0
  fi

  printf '%s\n' "$output"
  exit 0
fi

printf '{"success":false,"error":"METHOD_NOT_ALLOWED","message":"Use GET or POST"}\n'
exit 0
