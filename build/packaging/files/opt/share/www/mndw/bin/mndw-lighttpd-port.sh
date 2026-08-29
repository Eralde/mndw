#!/bin/sh
set -u

MNDW_ROOT=${MNDW_ROOT:-/opt}
MNDW_CONFIG_FILE=${MNDW_CONFIG_FILE:-$MNDW_ROOT/etc/mndw.conf}
MNDW_PROC_ROOT=${MNDW_PROC_ROOT:-/proc}
MNDW_STATE_FILE=${MNDW_STATE_FILE:-$MNDW_ROOT/var/lib/mndw/lighttpd-port}
MNDW_LIGHTTPD_POLICY_FILE=${MNDW_LIGHTTPD_POLICY_FILE:-$MNDW_ROOT/var/lib/mndw/lighttpd-port-policy}
MNDW_TMP_ROOT=${MNDW_TMP_ROOT:-$MNDW_ROOT/tmp/mndw}
MNDW_NETSTAT=${MNDW_NETSTAT:-}
MNDW_LIGHTTPD_BIN=${MNDW_LIGHTTPD_BIN:-$MNDW_ROOT/sbin/lighttpd}
MNDW_LIGHTTPD_INIT=${MNDW_LIGHTTPD_INIT:-$MNDW_ROOT/etc/init.d/S80lighttpd}
MNDW_MNDWD_INIT=${MNDW_MNDWD_INIT:-$MNDW_ROOT/etc/init.d/S70mndwd}
MNDW_LIGHTTPD_CONF=${MNDW_LIGHTTPD_CONF:-$MNDW_ROOT/etc/lighttpd/lighttpd.conf}
MNDW_LIGHTTPD_CONFD=${MNDW_LIGHTTPD_CONFD:-$MNDW_ROOT/etc/lighttpd/conf.d}
MNDW_LIGHTTPD_ERRORLOG=${MNDW_LIGHTTPD_ERRORLOG:-$MNDW_ROOT/var/log/lighttpd/error.log}
MNDW_LIGHTTPD_ERRORLOG_LINES=${MNDW_LIGHTTPD_ERRORLOG_LINES:-200}
MNDW_PROBE_LOG=${MNDW_PROBE_LOG:-$MNDW_TMP_ROOT/lighttpd-probe.log}
MNDW_INIT_LOG=${MNDW_INIT_LOG:-$MNDW_TMP_ROOT/lighttpd-init.log}
MNDW_PROBE_PID_FILE=${MNDW_PROBE_PID_FILE:-$MNDW_TMP_ROOT/lighttpd-probe.pid}
MNDW_PROBE_READY_TIMEOUT=${MNDW_PROBE_READY_TIMEOUT:-10}
MNDW_HANDOFF_READY_TIMEOUT=${MNDW_HANDOFF_READY_TIMEOUT:-10}
MNDW_PROBE_TERM_TIMEOUT=${MNDW_PROBE_TERM_TIMEOUT:-2}
MNDW_PROBE_KILL_TIMEOUT=${MNDW_PROBE_KILL_TIMEOUT:-2}
MNDW_SLEEP=${MNDW_SLEEP:-sleep}
MNDW_KILL=${MNDW_KILL:-kill}
MNDW_PIDOF=${MNDW_PIDOF:-pidof}

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
evidence_helper=${MNDW_EVIDENCE_HELPER:-$script_dir/mndw-lighttpd-port-evidence.sh}
. "$evidence_helper" || {
  echo "mndw: cannot load lighttpd port evidence helper: $evidence_helper" >&2
  exit 1
}

port_is_valid() {
  port_value=$1

  case "$port_value" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$port_value" -ge 99 ] 2>/dev/null && [ "$port_value" -le 199 ] 2>/dev/null
}

router_port_is_valid() {
  port_value=$1

  case "$port_value" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$port_value" -ge 1 ] 2>/dev/null && [ "$port_value" -le 65535 ] 2>/dev/null
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
  snapshot_listeners_stdout | sort -u > "$temporary_file" || {
    rm -f "$temporary_file"
    return 1
  }
  mv "$temporary_file" "$output_file" || {
    rm -f "$temporary_file"
    return 1
  }
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

wait_for_listener() {
  port_value=$1
  elapsed=0

  while ! is_listening "$port_value"; do
    [ "$elapsed" -ge "$MNDW_HANDOFF_READY_TIMEOUT" ] && return 1
    "$MNDW_SLEEP" 1
    elapsed=$((elapsed + 1))
  done
}

initialize_runtime_paths() {
  if [ -f "$MNDW_CONFIG_FILE" ]; then
    . "$MNDW_CONFIG_FILE" || return 1
  fi

  : "${DATA_DIR:=$MNDW_ROOT/var/lib/mndw}"
  : "${MNDW_RUNTIME_CONF:=$MNDW_ROOT/var/lib/mndw/lighttpd-runtime.conf}"
  : "${MNDW_LIGHTTPD_CONFD:=$MNDW_ROOT/etc/lighttpd/conf.d}"
  : "${MNDW_USER_PLUGINS_DIR:=$DATA_DIR/user-plugins}"
  : "${MNDW_PROXY_TARGET:=$DATA_DIR/proxy-target.conf}"
  : "${MNDW_LIGHTTPD_POLICY_FILE:=$MNDW_ROOT/var/lib/mndw/lighttpd-port-policy}"
  export MNDW_RUNTIME_CONF MNDW_LIGHTTPD_CONFD MNDW_USER_PLUGINS_DIR MNDW_PROXY_TARGET
  export MNDW_LIGHTTPD_POLICY_FILE
}

read_lighttpd_policy() {
  if [ ! -r "$MNDW_LIGHTTPD_POLICY_FILE" ]; then
    echo '[mndw] no ownership policy found; preserving existing main port — if this is a fresh install use install.sh' >&2
    printf '%s\n' preserve
    return 0
  fi

  policy_value=$(sed -n '1p' "$MNDW_LIGHTTPD_POLICY_FILE" | tr -d '\r')
  case "$policy_value" in
    preserve|mndw)
      printf '%s\n' "$policy_value"
      ;;
    *)
      echo "mndw: invalid lighttpd ownership policy in $MNDW_LIGHTTPD_POLICY_FILE; preserving existing main port" >&2
      printf '%s\n' preserve
      ;;
  esac
}

read_router_proxy_port() {
  [ -r "$MNDW_PROXY_TARGET" ] || return 1

  router_port=$(awk '
    /proxy\.server[[:space:]]*=/ {
      line = $0
      matches = gsub(/"port"[[:space:]]*=>[[:space:]]*[0-9]+/, "&", line)
      if (matches == 1 && match($0, /"port"[[:space:]]*=>[[:space:]]*[0-9]+/)) {
        value = substr($0, RSTART, RLENGTH)
        sub(/^.*=>[[:space:]]*/, "", value)
        print value
        found++
      } else if (matches > 1) {
        found += matches
      }
    }
    END { if (found != 1) exit 1 }
  ' "$MNDW_PROXY_TARGET") || return 1

  router_port_is_valid "$router_port" || return 1
  printf '%s\n' "$router_port"
}

cleanup_evidence_artifacts() {
  for artifact in \
    "${live_ports:-}" \
    "${foreign_ports:-}" "${foreign_ports:+$foreign_ports.sorted}" \
    "${owned_ports:-}" "${owned_ports:+$owned_ports.sorted}" \
    "${printed_config:-}"; do
    [ -n "$artifact" ] && rm -f "$artifact"
  done
}

cleanup_install_artifacts() {
  cleanup_evidence_artifacts
  rm -f "$MNDW_PROBE_PID_FILE"
}

read_state() {
  [ -r "$MNDW_STATE_FILE" ] || return 1

  state_value=$(sed -n '1p' "$MNDW_STATE_FILE" | tr -d '\r')
  port_is_valid "$state_value" || return 1
  printf '%s\n' "$state_value"
}

persisted_port_is_owned() {
  owned_port=$1
  live_file=$2
  foreign_file=$3
  owned_file=$4

  port_is_listed "$owned_port" "$live_file" &&
    port_is_listed "$owned_port" "$owned_file" &&
    ! port_is_listed "$owned_port" "$foreign_file"
}

select_port() {
  live_file=$1
  foreign_file=$2
  owned_file=$3
  persisted_port=$(read_state 2>/dev/null || true)

  if [ -n "$persisted_port" ] && ! browser_blocks_port "$persisted_port" &&
    ! port_is_listed "$persisted_port" "$foreign_file"; then
    if persisted_port_is_owned "$persisted_port" "$live_file" "$foreign_file" "$owned_file" ||
      { ! port_is_listed "$persisted_port" "$live_file" && ! is_listening "$persisted_port"; }; then
      printf '%s\n' "$persisted_port"
      return 0
    fi
  fi

  candidate=99

  while [ "$candidate" -le 199 ]; do
    if ! browser_blocks_port "$candidate" && ! port_is_listed "$candidate" "$foreign_file" &&
      ! port_is_listed "$candidate" "$live_file" &&
      ! is_listening "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi

    candidate=$((candidate + 1))
  done

  echo 'mndw: no free port in 99..199' >&2
  return 1
}

select_port_command() {
  initialize_runtime_paths || return 1
  mkdir -p "$MNDW_TMP_ROOT" || return 1

  live_ports="$MNDW_TMP_ROOT/lighttpd-live-ports.$$"
  foreign_ports="$MNDW_TMP_ROOT/lighttpd-foreign-ports.$$"
  owned_ports="$MNDW_TMP_ROOT/lighttpd-owned-ports.$$"
  : > "$foreign_ports" || {
    cleanup_evidence_artifacts
    return 1
  }
  : > "$owned_ports" || {
    cleanup_evidence_artifacts
    return 1
  }

  if ! snapshot_listeners "$live_ports"; then
    : > "$live_ports" || {
      cleanup_evidence_artifacts
      return 1
    }
    echo '[mndw] warning: unable to snapshot listeners' >> "$MNDW_PROBE_LOG" || true
  fi

  scan_configured_ports "$foreign_ports" "$owned_ports" || {
    cleanup_evidence_artifacts
    return 1
  }
  persisted_port=$(read_state 2>/dev/null || true)
  append_printed_ports_when_unowned "$persisted_port" "$foreign_ports" || {
    cleanup_evidence_artifacts
    return 1
  }
  normalize_evidence_file "$foreign_ports" || {
    cleanup_evidence_artifacts
    return 1
  }
  normalize_evidence_file "$owned_ports" || {
    cleanup_evidence_artifacts
    return 1
  }

  selected_port=$(select_port "$live_ports" "$foreign_ports" "$owned_ports")
  result=$?
  cleanup_evidence_artifacts
  [ "$result" -eq 0 ] || return "$result"
  printf '%s\n' "$selected_port"
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
  probe_listener_mode=$4
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
      if [ "$probe_listener_mode" = 'override' ] ||
        listener_added "$probe_current_snapshot" "$probe_previous_snapshot" "$probe_candidate"; then
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
  initialize_runtime_paths || return 1

  mkdir -p "$MNDW_ROOT/tmp/mndw/plugin-runtime" "$DATA_DIR" "$MNDW_ROOT/var/lib/mndw" "$MNDW_ROOT/var/lib/mndw-secrets" "$MNDW_TMP_ROOT" || return 1
  chmod 700 "$MNDW_ROOT/tmp/mndw/plugin-runtime" "$DATA_DIR" "$MNDW_ROOT/var/lib/mndw" "$MNDW_ROOT/var/lib/mndw-secrets" 2>/dev/null || true
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

  live_ports="$MNDW_TMP_ROOT/lighttpd-live-ports.$$"
  foreign_ports="$MNDW_TMP_ROOT/lighttpd-foreign-ports.$$"
  owned_ports="$MNDW_TMP_ROOT/lighttpd-owned-ports.$$"
  : > "$foreign_ports" || {
    cleanup_install_artifacts
    return 1
  }
  : > "$owned_ports" || {
    cleanup_install_artifacts
    return 1
  }
  if ! snapshot_listeners "$live_ports"; then
    : > "$live_ports" || {
      cleanup_install_artifacts
      return 1
    }
    echo '[mndw] warning: unable to snapshot listeners before stopping lighttpd' >> "$MNDW_PROBE_LOG"
  fi
  scan_configured_ports "$foreign_ports" "$owned_ports" || {
    cleanup_install_artifacts
    return 1
  }
  persisted_port=$(read_state 2>/dev/null || true)
  append_printed_ports_when_unowned "$persisted_port" "$foreign_ports" || {
    cleanup_install_artifacts
    return 1
  }
  normalize_evidence_file "$foreign_ports" || {
    echo 'mndw: failed to normalize foreign lighttpd port evidence' >&2
    cleanup_install_artifacts
    return 1
  }
  normalize_evidence_file "$owned_ports" || {
    echo 'mndw: failed to normalize owned lighttpd port evidence' >&2
    cleanup_install_artifacts
    return 1
  }

  "$MNDW_MNDWD_INIT" restart >> "$MNDW_INIT_LOG" 2>&1 || {
    echo "mndw: mndwd failed to restart; see $MNDW_INIT_LOG" >&2
    cleanup_install_artifacts
    return 1
  }
  [ -s "$MNDW_PROXY_TARGET" ] || {
    echo "mndw: mndwd did not create $MNDW_PROXY_TARGET" >&2
    cleanup_install_artifacts
    return 1
  }

  lighttpd_policy=$(read_lighttpd_policy)
  router_port=$(read_router_proxy_port) || {
    echo "mndw: cannot determine router port from router target $MNDW_PROXY_TARGET" >&2
    cleanup_install_artifacts
    return 1
  }

  probe_mode=socket
  handoff_mode=socket
  proactive_override=0
  if [ "$lighttpd_policy" = 'mndw' ] && [ "$router_port" != '80' ]; then
    probe_mode=override
    handoff_mode=override
    proactive_override=1
  fi

  if ! "$MNDW_LIGHTTPD_INIT" stop >> "$MNDW_INIT_LOG" 2>&1; then
    if lighttpd_is_running; then
      echo "mndw: lighttpd failed to stop; see $MNDW_INIT_LOG" >&2
      cleanup_install_artifacts
      return 1
    fi

    echo '[mndw] lighttpd already stopped; continuing' >> "$MNDW_INIT_LOG"
  fi

  candidate=$(select_port "$live_ports" "$foreign_ports" "$owned_ports") || {
    echo 'mndw: exhausted mndw port range 99..199' >&2
    cleanup_install_artifacts
    return 1
  }
  mode=$handoff_mode

  while [ "$candidate" -le 199 ]; do
    export MNDW_SELECTED_PORT=$candidate
    sh "$render_helper" --mode "$probe_mode" --port "$candidate" --output "$MNDW_RUNTIME_CONF" || {
      cleanup_install_artifacts
      return 1
    }

    previous_snapshot="$MNDW_TMP_ROOT/probe-listeners.$$.previous"
    snapshot_listeners "$previous_snapshot" || {
      cleanup_install_artifacts
      return 1
    }
    errorlog_offset=0
    if [ -r "$MNDW_LIGHTTPD_ERRORLOG" ]; then
      errorlog_offset=$(wc -c < "$MNDW_LIGHTTPD_ERRORLOG" 2>/dev/null | tr -d ' ')
    fi

    probe_once "$candidate" "$previous_snapshot" "$errorlog_offset" "$probe_mode"
    rm -f "$previous_snapshot"

    case "$PROBE_RESULT" in
      override)
        if [ "$lighttpd_policy" = 'preserve' ]; then
          echo 'mndw: lighttpd did not establish the selected dashboard listener; preserved main listener was not usable' >&2
          cleanup_install_artifacts
          return 1
        fi
        mode=override
        sh "$render_helper" --mode override --port "$candidate" --output "$MNDW_RUNTIME_CONF" || {
          cleanup_install_artifacts
          return 1
        }
        :
        ;;
      ready)
        mode=$handoff_mode
        if [ "$mode" != "$probe_mode" ]; then
          sh "$render_helper" --mode "$mode" --port "$candidate" --output "$MNDW_RUNTIME_CONF" || {
            cleanup_install_artifacts
            return 1
          }
        fi
        :
        ;;
      retry)
        candidate=$((candidate + 1))
        continue
        ;;
      *)
        echo "mndw: lighttpd probe failed; see $MNDW_PROBE_LOG" >&2
        cleanup_install_artifacts
        return 1
        ;;
    esac

    "$MNDW_LIGHTTPD_BIN" -t -f "$MNDW_LIGHTTPD_CONF" >> "$MNDW_PROBE_LOG" 2>&1 || {
      echo "mndw: lighttpd configuration check failed; see $MNDW_PROBE_LOG" >&2
      cleanup_install_artifacts
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
      cleanup_install_artifacts
      return 1
    fi

    if ! wait_for_listener "$candidate"; then
      echo "mndw: lighttpd started without selected port $candidate listening; see $MNDW_INIT_LOG" >&2
      cleanup_install_artifacts
      return 1
    fi

    break
  done

  if [ "$candidate" -gt 199 ]; then
    echo 'mndw: exhausted mndw port range 99..199' >&2
    cleanup_install_artifacts
    return 1
  fi

  write_state "$candidate" || {
    cleanup_install_artifacts
    return 1
  }
  cleanup_install_artifacts
  rm -f "$MNDW_PROBE_LOG" "$MNDW_INIT_LOG"

  if [ "$proactive_override" -eq 1 ]; then
    echo "[mndw] using override mode because router HTTP port is $router_port; lighttpd will not bind port 80"
  elif [ "$mode" = 'override' ]; then
    echo '[mndw] warning: bypassed effective port-80 lighttpd listener because it was occupied'
  fi
  echo "[mndw] installed. open http://<router-ip>:$candidate (dashboard port $candidate)"
  return 0
}

usage() {
  echo 'usage: mndw-lighttpd-port.sh {is-listening PORT|read-state|read-policy|read-router-port|select-port|write-state PORT|snapshot-listeners OUTPUT_FILE|install}' >&2
}

case "${1:-}" in
  is-listening)
    [ "$#" -eq 2 ] && port_is_valid "$2" && is_listening "$2"
    ;;
  read-state)
    [ "$#" -eq 1 ] && read_state
    ;;
  read-policy)
    [ "$#" -eq 1 ] && initialize_runtime_paths && read_lighttpd_policy
    ;;
  read-router-port)
    [ "$#" -eq 1 ] || {
      usage
      exit 2
    }
    initialize_runtime_paths && read_router_proxy_port
    ;;
  select-port)
    [ "$#" -eq 1 ] || {
      usage
      exit 2
    }
    select_port_command
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
