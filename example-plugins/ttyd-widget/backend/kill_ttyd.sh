#!/bin/sh

echo "Content-Type: application/json"
echo ""

TTYD_PID_FILE="${MNDW_TTYD_PID_FILE:-/opt/var/run/mndw-ttyd-widget.pid}"
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

if [ "$success" = true ]; then
  echo '{"success": true}'
else
  echo '{"success": false}'
fi
