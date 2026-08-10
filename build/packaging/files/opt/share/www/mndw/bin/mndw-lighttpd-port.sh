#!/bin/sh
set -u

MNDW_ROOT=${MNDW_ROOT:-/opt}
MNDW_PROC_ROOT=${MNDW_PROC_ROOT:-/proc}
MNDW_STATE_FILE=${MNDW_STATE_FILE:-$MNDW_ROOT/var/lib/mndw/lighttpd-port}
MNDW_TMP_ROOT=${MNDW_TMP_ROOT:-$MNDW_ROOT/tmp/mndw}
MNDW_NETSTAT=${MNDW_NETSTAT:-}
MNDW_LIGHTTPD_BIN=${MNDW_LIGHTTPD_BIN:-$MNDW_ROOT/sbin/lighttpd}
MNDW_LIGHTTPD_INIT=${MNDW_LIGHTTPD_INIT:-$MNDW_ROOT/etc/init.d/S80lighttpd}
MNDW_MNDWD_INIT=${MNDW_MNDWD_INIT:-$MNDW_ROOT/etc/init.d/S70mndwd}
MNDW_LIGHTTPD_CONF=${MNDW_LIGHTTPD_CONF:-$MNDW_ROOT/etc/lighttpd/lighttpd.conf}
MNDW_LIGHTTPD_ERRORLOG=${MNDW_LIGHTTPD_ERRORLOG:-$MNDW_ROOT/var/log/lighttpd/error.log}
MNDW_LIGHTTPD_ERRORLOG_LINES=${MNDW_LIGHTTPD_ERRORLOG_LINES:-200}
MNDW_PROBE_LOG=${MNDW_PROBE_LOG:-$MNDW_TMP_ROOT/lighttpd-probe.log}
MNDW_INIT_LOG=${MNDW_INIT_LOG:-$MNDW_TMP_ROOT/lighttpd-init.log}
MNDW_PROBE_PID_FILE=${MNDW_PROBE_PID_FILE:-$MNDW_TMP_ROOT/lighttpd-probe.pid}
MNDW_PROBE_READY_TIMEOUT=${MNDW_PROBE_READY_TIMEOUT:-10}
MNDW_PROBE_TERM_TIMEOUT=${MNDW_PROBE_TERM_TIMEOUT:-2}
MNDW_PROBE_KILL_TIMEOUT=${MNDW_PROBE_KILL_TIMEOUT:-2}
MNDW_SLEEP=${MNDW_SLEEP:-sleep}
MNDW_KILL=${MNDW_KILL:-kill}
MNDW_PIDOF=${MNDW_PIDOF:-pidof}

port_is_valid() {
  port_value=$1

  case "$port_value" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$port_value" -ge 99 ] 2>/dev/null && [ "$port_value" -le 199 ] 2>/dev/null
}

proc_snapshot_file() {
  proc_file=$1
  family=$2

  [ -r "$proc_file" ] || return 0

  while IFS=' ' read -r _ local_address _ connection_state _; do
    [ "$connection_state" = '0A' ] || continue

    port_hex=${local_address##*:}
    [ -n "$port_hex" ] || continue

    port_number=$(printf '%d' "0x$port_hex" 2>/dev/null) || continue
    printf '%s|%s\n' "$family" "$port_number"
  done < "$proc_file"
}

netstat_snapshot() {
  netstat_command=$MNDW_NETSTAT

  if [ -z "$netstat_command" ]; then
    netstat_command=$(command -v netstat 2>/dev/null || true)
  fi

  [ -n "$netstat_command" ] || return 1

  netstat_output=$($netstat_command -ln 2>/dev/null) || return 1

  printf '%s\n' "$netstat_output" | awk '
    $NF != "LISTEN" && $NF != "LISTENING" { next }
    {
      family = ($1 == "tcp6" || $1 ~ /6$/) ? "tcp6" : "tcp4"
      for (i = 1; i <= NF; i++) {
        endpoint = $i
        if (endpoint ~ /:[0-9]+$/ || endpoint ~ /\.[0-9]+$/) {
          port = endpoint
          sub(/^.*:/, "", port)
          sub(/^.*\./, "", port)
          if (port ~ /^[0-9]+$/) print family "|" port
        }
      }
    }
  '
}

snapshot_listeners_stdout() {
  netstat_data=$(netstat_snapshot 2>/dev/null || true)

  if [ -n "$netstat_data" ]; then
    printf '%s\n' "$netstat_data"
    return 0
  fi

  proc_snapshot_file "$MNDW_PROC_ROOT/net/tcp" tcp4
  proc_snapshot_file "$MNDW_PROC_ROOT/net/tcp6" tcp6
}

snapshot_listeners() {
  output_file=$1
  output_dir=$(dirname "$output_file")
  temporary_file="$output_file.$$"

  mkdir -p "$output_dir" || return 1
  snapshot_listeners_stdout | sort -u > "$temporary_file" || return 1
  mv "$temporary_file" "$output_file"
}

is_listening() {
  port_value=$1
  snapshot_file="$MNDW_TMP_ROOT/listeners.$$"

  mkdir -p "$MNDW_TMP_ROOT" || return 1
  snapshot_listeners "$snapshot_file" || return 1
  grep -F -q "|$port_value" "$snapshot_file"
  result=$?
  rm -f "$snapshot_file"
  return $result
}

read_state() {
  [ -r "$MNDW_STATE_FILE" ] || return 1

  state_value=$(sed -n '1p' "$MNDW_STATE_FILE" | tr -d '\r')
  port_is_valid "$state_value" || return 1
  printf '%s\n' "$state_value"
}

select_port() {
  persisted_port=$(read_state 2>/dev/null || true)

  if [ -n "$persisted_port" ] && ! is_listening "$persisted_port"; then
    printf '%s\n' "$persisted_port"
    return 0
  fi

  candidate=99

  while [ "$candidate" -le 199 ]; do
    if ! is_listening "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi

    candidate=$((candidate + 1))
  done

  echo 'mndw: no free port in 99..199' >&2
  return 1
}

write_state() {
  state_value=$1
  port_is_valid "$state_value" || {
    echo "mndw: invalid port: $state_value" >&2
    return 1
  }

  state_dir=$(dirname "$MNDW_STATE_FILE")
  temporary_file="$MNDW_STATE_FILE.$$"

  mkdir -p "$state_dir" || return 1
  printf '%s\n' "$state_value" > "$temporary_file" || return 1
  mv "$temporary_file" "$MNDW_STATE_FILE"
}

process_is_alive() {
  "$MNDW_KILL" -0 "$1" 2>/dev/null
}

lighttpd_is_running() {
  if [ -n "$MNDW_PIDOF" ] && "$MNDW_PIDOF" lighttpd >/dev/null 2>&1; then
    return 0
  fi

  ps w 2>/dev/null | grep -E -q '(^|[ /])lighttpd([[:space:]]|$)'
}

wait_for_process_exit() {
  wait_pid=$1
  wait_limit=$2
  wait_elapsed=0

  while process_is_alive "$wait_pid"; do
    [ "$wait_elapsed" -lt "$wait_limit" ] || return 1
    "$MNDW_SLEEP" 1
    wait_elapsed=$((wait_elapsed + 1))
  done

  return 0
}

cleanup_probe() {
  cleanup_pid=$1

  if process_is_alive "$cleanup_pid"; then
    "$MNDW_KILL" -TERM "$cleanup_pid" 2>/dev/null || true

    if ! wait_for_process_exit "$cleanup_pid" "$MNDW_PROBE_TERM_TIMEOUT"; then
      "$MNDW_KILL" -KILL "$cleanup_pid" 2>/dev/null || true

      if ! wait_for_process_exit "$cleanup_pid" "$MNDW_PROBE_KILL_TIMEOUT"; then
        echo "mndw: probe PID $cleanup_pid did not exit after SIGKILL" >&2
        return 1
      fi
    fi
  fi

  wait "$cleanup_pid" 2>/dev/null || true
  rm -f "$MNDW_PROBE_PID_FILE"
  return 0
}

append_errorlog_delta() {
  errorlog_offset=$1

  [ -r "$MNDW_LIGHTTPD_ERRORLOG" ] || return 0

  errorlog_size=$(wc -c < "$MNDW_LIGHTTPD_ERRORLOG" 2>/dev/null | tr -d ' ')
  case "$errorlog_size" in
    ''|*[!0-9]*) errorlog_size=0 ;;
  esac

  {
    echo '[mndw] lighttpd errorlog delta:'
    if [ "$errorlog_size" -ge "$errorlog_offset" ] 2>/dev/null; then
      dd if="$MNDW_LIGHTTPD_ERRORLOG" bs=1 skip="$errorlog_offset" 2>/dev/null | tail -n "$MNDW_LIGHTTPD_ERRORLOG_LINES"
    else
      tail -n "$MNDW_LIGHTTPD_ERRORLOG_LINES" "$MNDW_LIGHTTPD_ERRORLOG"
    fi
  } >> "$MNDW_PROBE_LOG"
}

listener_added() {
  current_snapshot=$1
  previous_snapshot=$2
  selected_port=$3

  while IFS= read -r listener; do
    [ -n "$listener" ] || continue
    case "$listener" in
      *"|$selected_port") continue ;;
    esac

    if ! grep -F -q -x "$listener" "$previous_snapshot"; then
      return 0
    fi
  done < "$current_snapshot"

  return 1
}

probe_log_has_port_failure() {
  failed_port=$1
  grep -E -q "bind\\(\\).*((0\\.0\\.0\\.0:$failed_port:)|(\\[::\\]:$failed_port:)|(:::$failed_port:)).*Address already in use" "$MNDW_PROBE_LOG"
}

probe_log_has_base_failure() {
  grep -E -q 'bind\(\).*((0\.0\.0\.0:80:)|(\[::\]:80:)|(:::{1}80:)).*Address already in use' "$MNDW_PROBE_LOG"
}

probe_once() {
  probe_candidate=$1
  probe_previous_snapshot=$2
  probe_errorlog_offset=$3
  probe_current_snapshot="$MNDW_TMP_ROOT/probe-listeners.$$.current"
  probe_elapsed=0
  probe_pid=

  printf '[mndw] candidate %s probe\n' "$probe_candidate" >> "$MNDW_PROBE_LOG"
  export MNDW_SELECTED_PORT=$probe_candidate
  "$MNDW_LIGHTTPD_BIN" -D -f "$MNDW_LIGHTTPD_CONF" >> "$MNDW_PROBE_LOG" 2>&1 &
  probe_pid=$!
  printf '%s\n' "$probe_pid" > "$MNDW_PROBE_PID_FILE"

  while :; do
    if ! process_is_alive "$probe_pid"; then
      wait "$probe_pid" 2>/dev/null || true
      append_errorlog_delta "$probe_errorlog_offset"

      if probe_log_has_base_failure; then
        PROBE_RESULT=override
      elif probe_log_has_port_failure "$probe_candidate"; then
        PROBE_RESULT=retry
      else
        PROBE_RESULT=fatal
      fi

      rm -f "$MNDW_PROBE_PID_FILE"
      return 0
    fi

    if ! snapshot_listeners "$probe_current_snapshot"; then
      cleanup_probe "$probe_pid" || true
      append_errorlog_delta "$probe_errorlog_offset"
      PROBE_RESULT=fatal
      return 0
    fi

    if grep -F -q -x "tcp4|$probe_candidate" "$probe_current_snapshot" || grep -F -q -x "tcp6|$probe_candidate" "$probe_current_snapshot"; then
      if listener_added "$probe_current_snapshot" "$probe_previous_snapshot" "$probe_candidate"; then
        if cleanup_probe "$probe_pid"; then
          append_errorlog_delta "$probe_errorlog_offset"
          PROBE_RESULT=ready
        else
          append_errorlog_delta "$probe_errorlog_offset"
          PROBE_RESULT=fatal
        fi

        rm -f "$probe_current_snapshot"
        return 0
      fi
    fi

    if [ "$probe_elapsed" -ge "$MNDW_PROBE_READY_TIMEOUT" ]; then
      cleanup_probe "$probe_pid" || true
      append_errorlog_delta "$probe_errorlog_offset"
      PROBE_RESULT=fatal
      rm -f "$probe_current_snapshot"
      return 0
    fi

    "$MNDW_SLEEP" 1
    probe_elapsed=$((probe_elapsed + 1))
  done
}

run_install() {
  install_script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  render_helper=${MNDW_RENDER_HELPER:-$install_script_dir/mndw-render-lighttpd.sh}
  MNDW_RUNTIME_CONF=${MNDW_RUNTIME_CONF:-$MNDW_ROOT/var/lib/mndw/lighttpd-runtime.conf}
  MNDW_PROXY_TARGET=${MNDW_PROXY_TARGET:-$MNDW_ROOT/var/lib/mndw/proxy-target.conf}
  export MNDW_PROXY_TARGET

  mkdir -p "$MNDW_ROOT/tmp/mndw/plugin-runtime" "$MNDW_ROOT/var/lib/mndw" "$MNDW_ROOT/var/lib/mndw-secrets" "$MNDW_TMP_ROOT" || return 1
  chmod 700 "$MNDW_ROOT/tmp/mndw/plugin-runtime" "$MNDW_ROOT/var/lib/mndw" "$MNDW_ROOT/var/lib/mndw-secrets" 2>/dev/null || true
  : > "$MNDW_PROBE_LOG" || return 1
  : > "$MNDW_INIT_LOG" || return 1

  [ -x "$MNDW_MNDWD_INIT" ] || {
    echo "mndw: missing mndwd init script: $MNDW_MNDWD_INIT" >&2
    return 1
  }
  [ -x "$MNDW_LIGHTTPD_INIT" ] || {
    echo "mndw: missing lighttpd init script: $MNDW_LIGHTTPD_INIT" >&2
    return 1
  }

  "$MNDW_MNDWD_INIT" start >> "$MNDW_INIT_LOG" 2>&1 || {
    echo "mndw: mndwd failed to start; see $MNDW_INIT_LOG" >&2
    return 1
  }
  [ -s "$MNDW_PROXY_TARGET" ] || {
    echo "mndw: mndwd did not create $MNDW_PROXY_TARGET" >&2
    return 1
  }

  if ! "$MNDW_LIGHTTPD_INIT" stop >> "$MNDW_INIT_LOG" 2>&1; then
    if lighttpd_is_running; then
      echo "mndw: lighttpd failed to stop; see $MNDW_INIT_LOG" >&2
      return 1
    fi

    echo '[mndw] lighttpd already stopped; continuing' >> "$MNDW_INIT_LOG"
  fi

  candidate=$(select_port) || {
    echo 'mndw: exhausted mndw port range 99..199' >&2
    return 1
  }
  mode=socket

  while [ "$candidate" -le 199 ]; do
    export MNDW_SELECTED_PORT=$candidate
    sh "$render_helper" --mode socket --port "$candidate" --output "$MNDW_RUNTIME_CONF" || return 1

    previous_snapshot="$MNDW_TMP_ROOT/probe-listeners.$$.previous"
    snapshot_listeners "$previous_snapshot" || return 1
    errorlog_offset=0
    if [ -r "$MNDW_LIGHTTPD_ERRORLOG" ]; then
      errorlog_offset=$(wc -c < "$MNDW_LIGHTTPD_ERRORLOG" 2>/dev/null | tr -d ' ')
    fi

    probe_once "$candidate" "$previous_snapshot" "$errorlog_offset"
    rm -f "$previous_snapshot"

    case "$PROBE_RESULT" in
      override)
        mode=override
        sh "$render_helper" --mode override --port "$candidate" --output "$MNDW_RUNTIME_CONF" || return 1
        :
        ;;
      ready)
        mode=socket
        :
        ;;
      retry)
        candidate=$((candidate + 1))
        continue
        ;;
      *)
        echo "mndw: lighttpd probe failed; see $MNDW_PROBE_LOG" >&2
        return 1
        ;;
    esac

    "$MNDW_LIGHTTPD_BIN" -t -f "$MNDW_LIGHTTPD_CONF" >> "$MNDW_PROBE_LOG" 2>&1 || {
      echo "mndw: lighttpd configuration check failed; see $MNDW_PROBE_LOG" >&2
      return 1
    }

    export MNDW_SELECTED_PORT=$candidate
    : > "$MNDW_INIT_LOG"
    printf '[mndw] candidate %s daemon handoff\n' "$candidate" >> "$MNDW_PROBE_LOG"
    if ! "$MNDW_LIGHTTPD_INIT" restart >> "$MNDW_INIT_LOG" 2>&1; then
      cat "$MNDW_INIT_LOG" >> "$MNDW_PROBE_LOG"
      if probe_log_has_port_failure "$candidate"; then
        candidate=$((candidate + 1))
        "$MNDW_LIGHTTPD_INIT" stop >> "$MNDW_INIT_LOG" 2>&1 || true
        continue
      fi

      echo "mndw: lighttpd failed to start; see $MNDW_INIT_LOG and $MNDW_PROBE_LOG" >&2
      return 1
    fi

    if ! is_listening "$candidate"; then
      echo "mndw: lighttpd started without selected port $candidate listening; see $MNDW_INIT_LOG" >&2
      return 1
    fi

    break
  done

  if [ "$candidate" -gt 199 ]; then
    echo 'mndw: exhausted mndw port range 99..199' >&2
    return 1
  fi

  write_state "$candidate" || return 1
  rm -f "$MNDW_PROBE_LOG" "$MNDW_INIT_LOG" "$MNDW_PROBE_PID_FILE"

  if [ "$mode" = 'override' ]; then
    echo '[mndw] warning: bypassed effective port-80 lighttpd listener because it was occupied'
  fi
  echo "[mndw] installed. open http://<router-ip>:$candidate (dashboard port $candidate)"
  return 0
}

usage() {
  echo 'usage: mndw-lighttpd-port.sh {is-listening PORT|read-state|select-port|write-state PORT|snapshot-listeners OUTPUT_FILE|install}' >&2
}

case "${1:-}" in
  is-listening)
    [ "$#" -eq 2 ] && port_is_valid "$2" && is_listening "$2"
    ;;
  read-state)
    [ "$#" -eq 1 ] && read_state
    ;;
  select-port)
    [ "$#" -eq 1 ] && select_port
    ;;
  write-state)
    [ "$#" -eq 2 ] && write_state "$2"
    ;;
  snapshot-listeners)
    [ "$#" -eq 2 ] && snapshot_listeners "$2"
    ;;
  install)
    run_install
    ;;
  *)
    usage
    exit 2
    ;;
esac
