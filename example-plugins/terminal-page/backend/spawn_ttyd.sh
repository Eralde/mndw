#!/bin/sh

echo "Content-Type: application/json"
echo ""

TTYD_BIN="${MNDW_TTYD_BIN:-/opt/bin/ttyd}"
DAEMONIZE_BIN="${MNDW_DAEMONIZE_BIN:-/opt/bin/daemonize}"
TTYD_PORT="7681"
TTYD_PID_FILE="${MNDW_TTYD_PID_FILE:-/opt/var/run/mndw-terminal-page.pid}"

process_start_time() {
  pid="$1"
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  stat="${stat#*) }"
  set -- $stat
  printf '%s\n' "${20}"
}

pid_file_is_owned() {
  [ -f "$TTYD_PID_FILE" ] || return 1

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

if [ ! -x "$TTYD_BIN" ]; then
  echo '{"success": false, "error": "ttyd is not installed"}'
  exit 0
fi

if [ ! -x "$DAEMONIZE_BIN" ]; then
  echo '{"success": false, "error": "daemonize is not installed"}'
  exit 0
fi

# Read the request body from stdin exactly once (EOF-safe; the trailing sentinel
# preserves any trailing newline). The daemon pipes the POST body here.
REQUEST_BODY="$(cat; printf 'x')"
REQUEST_BODY="${REQUEST_BODY%x}"

# Minimal POSIX-sh parse: the frontend only ever sends {"console":"router"} or
# {"console":"entware"}. Anything else falls back to router.
CONSOLE="router"
case "$REQUEST_BODY" in
  *'"console"'*'"entware"'*) CONSOLE="entware" ;;
esac

case "$CONSOLE" in
  entware) TTYD_COMMAND="/opt/bin/sh" ;;
  *) TTYD_COMMAND="ndmc" ;;
esac

NETSTAT_BIN="${MNDW_NETSTAT_BIN:-/opt/bin/netstat}"
GREP_BIN="${MNDW_GREP_BIN:-/opt/bin/grep}"

if [ ! -x "$NETSTAT_BIN" ]; then
  NETSTAT_BIN="netstat"
fi

if [ ! -x "$GREP_BIN" ]; then
  GREP_BIN="grep"
fi

if "$NETSTAT_BIN" -tln 2>/dev/null | "$GREP_BIN" -q ":$TTYD_PORT "; then
  if pid_file_is_owned; then
    recorded_console="$(cat "${TTYD_PID_FILE}.console" 2>/dev/null | tr -d '[:space:]')"

    if [ -n "$recorded_console" ] && [ "$recorded_console" != "$CONSOLE" ]; then
      # Requested console differs: tear down via kill_ttyd.sh (which removes the
      # pid-file and polls the port free), drop the sidecar, then fall through to
      # a fresh spawn below. Do not duplicate the kill logic here.
      sh "$(dirname "$0")/kill_ttyd.sh" >/dev/null 2>&1
      rm -f "${TTYD_PID_FILE}.console"
    else
      echo "{\"success\": true, \"port\": $TTYD_PORT}"
      exit 0
    fi
  else
    # Port bound but not by an owned ttyd (started outside the plugin): reuse as-is.
    rm -f "$TTYD_PID_FILE"
    echo "{\"success\": true, \"port\": $TTYD_PORT}"
    exit 0
  fi
fi

pid_dir="${TTYD_PID_FILE%/*}"
if [ "$pid_dir" = "$TTYD_PID_FILE" ]; then
  pid_dir="."
fi
mkdir -p "$pid_dir"
rm -f "$TTYD_PID_FILE"

if ! "$DAEMONIZE_BIN" -p "$TTYD_PID_FILE" "$TTYD_BIN" -p "$TTYD_PORT" -W "$TTYD_COMMAND"; then
  rm -f "$TTYD_PID_FILE"
  echo '{"success": false, "error": "Failed to spawn ttyd"}'
  exit 0
fi

pid_data="$(cat "$TTYD_PID_FILE" 2>/dev/null)"
set -- $pid_data
pid="$1"
start_time="$(process_start_time "$pid")"
if [ -n "$start_time" ]; then
  printf '%s %s\n' "$pid" "$start_time" > "$TTYD_PID_FILE"
fi

printf '%s\n' "$CONSOLE" > "${TTYD_PID_FILE}.console"

echo "{\"success\": true, \"port\": $TTYD_PORT}"
