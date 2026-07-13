#!/bin/sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MNDW_PING_RUNTIME_DIR="${MNDW_PING_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
export MNDW_PING_STATE_DIR="${MNDW_PING_STATE_DIR:-$SCRIPT_DIR/../.state}"

# Asset mode may not survive the pack->zip->extract round-trip; self-heal.
chmod +x "$SCRIPT_DIR/ping-util" 2>/dev/null

printf 'Content-Type: application/json\r\n\r\n'

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g; s/\n/\\n/g'
}

output="$("$SCRIPT_DIR/ping-util" daemon 2>&1)"
rc=$?

if [ "$rc" -ne 0 ]; then
  printf '{"success":false,"error":"PING_DAEMON_START_FAILED","message":"Failed to start ping daemon","raw":"%s"}\n' "$(json_escape "$output")"
  exit 0
fi

printf '%s\n' "$output"
