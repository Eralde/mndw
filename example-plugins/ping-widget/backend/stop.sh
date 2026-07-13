#!/bin/sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MNDW_PING_RUNTIME_DIR="${MNDW_PING_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
export MNDW_PING_STATE_DIR="${MNDW_PING_STATE_DIR:-$SCRIPT_DIR/../.state}"

printf 'Content-Type: application/json\r\n\r\n'

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g; s/\n/\\n/g'
}

output="$("$SCRIPT_DIR/ping-util" stop 2>&1)"
rc=$?

if [ "$rc" -ne 0 ]; then
  printf '{"success":false,"error":"PING_DAEMON_STOP_FAILED","message":"Failed to stop ping daemon","raw":"%s"}\n' "$(json_escape "$output")"
  exit 0
fi

printf '%s\n' "$output"
