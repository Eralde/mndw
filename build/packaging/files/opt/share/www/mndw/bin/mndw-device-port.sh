#!/bin/sh
set -u

MNDW_ROOT=${MNDW_ROOT:-/opt}
MNDW_NETSTAT=${MNDW_NETSTAT:-}
MNDW_CURL=${MNDW_CURL:-}
MNDW_WGET=${MNDW_WGET:-}
MNDW_DEVICE_PORT=${MNDW_DEVICE_PORT:-}
MNDW_DASHBOARD_PORT_FILE=${MNDW_DASHBOARD_PORT_FILE:-$MNDW_ROOT/var/lib/mndw/frontend-port}
MNDW_DASHBOARD_PORT_FILE_LEGACY=${MNDW_DASHBOARD_PORT_FILE_LEGACY:-$MNDW_ROOT/var/lib/mndw/lighttpd-port}
MNDW_DEVICE_PROBE_TIMEOUT=${MNDW_DEVICE_PROBE_TIMEOUT:-3}

port_is_valid() {
  port_value=$1

  case "$port_value" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$port_value" -ge 1 ] 2>/dev/null && [ "$port_value" -le 65535 ] 2>/dev/null
}

device_ip_is_valid() {
  [ -n "$1" ]
}

dashboard_ports() {
  for port_file in "$MNDW_DASHBOARD_PORT_FILE" "$MNDW_DASHBOARD_PORT_FILE_LEGACY"; do
    [ -r "$port_file" ] || continue
    port_value=$(sed -n '1p' "$port_file" | tr -d '\r')
    port_is_valid "$port_value" && printf '%s\n' "$port_value"
  done
}

netstat_command() {
  if [ -n "$MNDW_NETSTAT" ]; then
    printf '%s\n' "$MNDW_NETSTAT"
    return 0
  fi

  command -v netstat 2>/dev/null
}

list_device_listener_ports() {
  device_ip=$1
  netstat_command_path=$(netstat_command) || return 1
  netstat_output=$($netstat_command_path -lnt 2>/dev/null) || return 1
  dashboard_port_values=$(dashboard_ports)

  listener_ports=$(
    printf '%s\n' "$netstat_output" | awk -v device_ip="$device_ip" '
    {
      listening = 0
      for (field_index = 1; field_index <= NF; field_index++) {
        if ($field_index == "LISTEN" || $field_index == "LISTENING") {
          listening = 1
        }
      }
      if (!listening) {
        next
      }

      endpoint = $4
      if (endpoint !~ /:[0-9]+$/) {
        next
      }

      port = endpoint
      sub(/^.*:/, "", port)
      host = endpoint
      sub(/:[0-9]+$/, "", host)

      if (host == device_ip || host == "0.0.0.0" || host == "*" || host == "::" || host == "[::]") {
        print port
      }
    }
    ' | sort -n -u
  )

  remaining_ports="$listener_ports"
  for dashboard_port_value in $dashboard_port_values; do
    remaining_ports=$(printf '%s\n' "$remaining_ports" | grep -F -x -v "$dashboard_port_value" || true)
  done
  printf '%s\n' "$remaining_ports"
}

select_http_client() {
  if [ -n "$MNDW_CURL" ]; then
    command -v "$MNDW_CURL" >/dev/null 2>&1 || return 1
    HTTP_CLIENT=curl
    HTTP_COMMAND=$MNDW_CURL
    return 0
  fi

  if [ -n "$MNDW_WGET" ]; then
    command -v "$MNDW_WGET" >/dev/null 2>&1 || return 1
    HTTP_CLIENT=wget
    HTTP_COMMAND=$MNDW_WGET
    return 0
  fi

  if HTTP_COMMAND=$(command -v curl 2>/dev/null); then
    HTTP_CLIENT=curl
    return 0
  fi

  if HTTP_COMMAND=$(command -v wget 2>/dev/null); then
    HTTP_CLIENT=wget
    return 0
  fi

  if [ -x "$MNDW_ROOT/bin/wget" ]; then
    HTTP_CLIENT=wget
    HTTP_COMMAND=$MNDW_ROOT/bin/wget
    return 0
  fi

  if [ -x "$MNDW_ROOT/libexec/wget-ssl" ]; then
    HTTP_CLIENT=wget
    HTTP_COMMAND=$MNDW_ROOT/libexec/wget-ssl
    return 0
  fi

  return 1
}

wget_is_gnu() {
  wget_version=$(LC_ALL=C "$1" -V 2>&1)
  wget_version_status=$?
  [ "$wget_version_status" -eq 0 ] || return 1
  wget_version_first_line=$(printf '%s\n' "$wget_version" | sed -n '1p')
  case "$wget_version_first_line" in
    'GNU Wget'*) return 0 ;;
    *) return 1 ;;
  esac
}

http_client_is_usable() {
  case "$HTTP_CLIENT" in
    wget)
      selected_wget=$HTTP_COMMAND
      wget_is_gnu "$selected_wget" && return 0
      HTTP_REJECTED_WGET=$selected_wget

      if [ -z "$MNDW_WGET" ]; then
        for fallback_wget in "$MNDW_ROOT/bin/wget" "$MNDW_ROOT/libexec/wget-ssl"; do
          [ -x "$fallback_wget" ] || continue
          [ "$fallback_wget" = "$selected_wget" ] && continue
          HTTP_COMMAND=$fallback_wget
          wget_is_gnu "$HTTP_COMMAND" && return 0
        done
      fi

      HTTP_COMMAND=$selected_wget
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

auth_challenge_present() {
  printf '%s\n' "$1" | grep -Eiq '^[[:space:]]*WWW-Authenticate:[[:space:]]*[^[:space:]]*x-ndw[24]-interactive'
}

probe_device_auth() {
  device_ip=$1
  port_value=$2
  auth_url="http://$device_ip:$port_value/auth"
  response=

  case "$HTTP_CLIENT" in
    curl)
      response=$(
        "$HTTP_COMMAND" \
          --silent \
          --show-error \
          --connect-timeout "$MNDW_DEVICE_PROBE_TIMEOUT" \
          --max-time "$MNDW_DEVICE_PROBE_TIMEOUT" \
          --dump-header - \
          --output /dev/null \
          "$auth_url" 2>/dev/null
      )
      probe_status=$?
      if [ "$probe_status" -gt 128 ]; then
        HTTP_CLIENT_CRASH_STATUS=$probe_status
        return 2
      fi
      [ "$probe_status" -eq 0 ] || return 1
      ;;
    wget)
      response=$(
        "$HTTP_COMMAND" \
          -S \
          -O /dev/null \
          -T "$MNDW_DEVICE_PROBE_TIMEOUT" \
          -t 1 \
          "$auth_url" 2>&1
      )
      probe_status=$?
      if [ "$probe_status" -gt 128 ]; then
        HTTP_CLIENT_CRASH_STATUS=$probe_status
        return 2
      fi
      ;;
    *)
      return 1
      ;;
  esac

  auth_challenge_present "$response"
}

detect_device_port() {
  device_ip=$1

  device_ip_is_valid "$device_ip" || {
    echo 'mndw: device IP is required' >&2
    return 1
  }

  if [ -n "$MNDW_DEVICE_PORT" ]; then
    port_is_valid "$MNDW_DEVICE_PORT" || {
      echo "mndw: invalid MNDW_DEVICE_PORT: $MNDW_DEVICE_PORT" >&2
      return 1
    }
    printf '%s\n' "$MNDW_DEVICE_PORT"
    return 0
  fi

  HTTP_REJECTED_WGET=
  if ! select_http_client || ! http_client_is_usable; then
    if [ -n "$HTTP_REJECTED_WGET" ]; then
      echo "mndw: device port detection requires curl or GNU Wget (opkg install wget-ssl); or set MNDW_DEVICE_PORT (found wget at $HTTP_REJECTED_WGET, but it is not GNU Wget or failed -V)" >&2
    else
      echo 'mndw: device port detection requires curl or GNU Wget (opkg install wget-ssl); or set MNDW_DEVICE_PORT' >&2
    fi
    return 1
  fi

  candidate_ports=$(list_device_listener_ports "$device_ip") || {
    echo 'mndw: unable to enumerate device TCP listeners' >&2
    return 1
  }

  [ -n "$candidate_ports" ] || {
    echo "mndw: no TCP listeners found on device IP $device_ip" >&2
    return 1
  }

  HTTP_CLIENT_CRASH_STATUS=
  for candidate in $candidate_ports; do
    echo "[mndw] probing device /auth on $device_ip:$candidate" >&2
    if probe_device_auth "$device_ip" "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    else
      probe_status=$?
      if [ "$probe_status" -eq 2 ]; then
        echo "mndw: HTTP client $HTTP_COMMAND crashed (exit $HTTP_CLIENT_CRASH_STATUS) while probing; reinstall it or set MNDW_DEVICE_PORT" >&2
        return 1
      fi
    fi
  done

  echo "mndw: no device /auth listener found on $device_ip; candidates: $candidate_ports; set MNDW_DEVICE_PORT" >&2
  return 1
}

usage() {
  echo 'usage: mndw-device-port.sh detect DEVICE_IP' >&2
}

case "${1:-}" in
  detect)
    [ "$#" -eq 2 ] || {
      usage
      exit 2
    }
    detect_device_port "$2"
    ;;
  *)
    usage
    exit 2
    ;;
esac
