#!/bin/sh

echo "Content-Type: application/json"
echo ""

TTYD_PID_FILE="${MNDW_TTYD_PID_FILE:-/opt/var/run/mndw-terminal-page.pid}"
success=true

process_start_time() {
  pid="$1"
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  stat="${stat#*) }"
  set -- $stat
  printf '%s\n' "${20}"
}

pid_file_is_owned() {
  pid_data="$(cat "$TTYD_PID_FILE" 2>/dev/null)"
  set -- $pid_data
  pid="$1"
  recorded_start_time="$2"

  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac

  if [ -n "$recorded_start_time" ]; then
    current_start_time="$(process_start_time "$pid")" || return 1

    [ "$current_start_time" = "$recorded_start_time" ] || return 1

    return 0
  fi

  # Device targets have /proc; accept PID-only files only in non-Linux dev shells.
  [ ! -d /proc ] && kill -0 "$pid" 2>/dev/null
}

if [ -f "$TTYD_PID_FILE" ]; then
  success=false

  if pid_file_is_owned; then
    pid_data="$(cat "$TTYD_PID_FILE")"
    set -- $pid_data
    pid="$1"

    if ! kill -0 "$pid" 2>/dev/null || kill "$pid" 2>/dev/null; then
      success=true
    fi
  fi

  rm -f "$TTYD_PID_FILE"
fi

NETSTAT_BIN="${MNDW_NETSTAT_BIN:-/opt/bin/netstat}"
GREP_BIN="${MNDW_GREP_BIN:-/opt/bin/grep}"
[ -x "$NETSTAT_BIN" ] || NETSTAT_BIN="netstat"
[ -x "$GREP_BIN" ] || GREP_BIN="grep"
TTYD_PORT="7681"

# Wait for the listen socket to be released (bounded: 20 * 100ms) so a fast
# reconnect with a different console can't reuse the stale ttyd. Fractional sleep
# is supported by the Entware/darwin sleep this plugin runs under.
i=0
while [ "$i" -lt 20 ]; do
  "$NETSTAT_BIN" -tln 2>/dev/null | "$GREP_BIN" -q ":$TTYD_PORT " || break
  i=$((i + 1))
  sleep 0.1
done

if [ "$success" = true ]; then
  echo '{"success": true}'
else
  echo '{"success": false}'
fi
