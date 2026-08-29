#!/bin/sh
set -u

MNDW_ROOT=${MNDW_ROOT:-/opt}
MNDW_NETSTAT=${MNDW_NETSTAT:-}
MNDW_CURL=${MNDW_CURL:-}
MNDW_WGET=${MNDW_WGET:-}
MNDW_ROUTER_PORT=${MNDW_ROUTER_PORT:-}
MNDW_DASHBOARD_PORT_FILE=${MNDW_DASHBOARD_PORT_FILE:-$MNDW_ROOT/var/lib/mndw/lighttpd-port}
MNDW_ROUTER_PROBE_TIMEOUT=${MNDW_ROUTER_PROBE_TIMEOUT:-3}

port_is_valid() {
  port_value=$1

  case "$port_value" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$port_value" -ge 1 ] 2>/dev/null && [ "$port_value" -le 65535 ] 2>/dev/null
}

router_ip_is_valid() {
  [ -n "$1" ]
}

dashboard_port() {
  [ -r "$MNDW_DASHBOARD_PORT_FILE" ] || return 0

  port_value=$(sed -n '1p' "$MNDW_DASHBOARD_PORT_FILE" | tr -d '\r')
  port_is_valid "$port_value" && printf '%s\n' "$port_value"
}

netstat_command() {
  if [ -n "$MNDW_NETSTAT" ]; then
    printf '%s\n' "$MNDW_NETSTAT"
    return 0
  fi

  command -v netstat 2>/dev/null
}

list_router_listener_ports() {
  router_ip=$1
  netstat_command_path=$(netstat_command) || return 1
  netstat_output=$($netstat_command_path -lnt 2>/dev/null) || return 1
  dashboard_port_value=$(dashboard_port)

  listener_ports=$(
    printf '%s\n' "$netstat_output" | awk -v router_ip="$router_ip" '
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

      if (host == router_ip || host == "0.0.0.0" || host == "*" || host == "::" || host == "[::]") {
        print port
      }
    }
    ' | sort -n -u
  )

  if [ -n "$dashboard_port_value" ]; then
    printf '%s\n' "$listener_ports" | grep -F -x -v "$dashboard_port_value" || true
  else
    printf '%s\n' "$listener_ports"
  fi
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

  return 1
}

auth_challenge_present() {
  printf '%s\n' "$1" | grep -Eiq '^[[:space:]]*WWW-Authenticate:[[:space:]]*[^[:space:]]*x-ndw[24]-interactive'
}

probe_router_auth() {
  router_ip=$1
  port_value=$2
  auth_url="http://$router_ip:$port_value/auth"
  response=

  case "$HTTP_CLIENT" in
    curl)
      response=$(
        "$HTTP_COMMAND" \
          --silent \
          --show-error \
          --connect-timeout "$MNDW_ROUTER_PROBE_TIMEOUT" \
          --max-time "$MNDW_ROUTER_PROBE_TIMEOUT" \
          --dump-header - \
          --output /dev/null \
          "$auth_url" 2>/dev/null
      ) || return 1
      ;;
    wget)
      response=$(
        "$HTTP_COMMAND" \
          -S \
          -O /dev/null \
          -T "$MNDW_ROUTER_PROBE_TIMEOUT" \
          "$auth_url" 2>&1
      ) || true
      ;;
    *)
      return 1
      ;;
  esac

  auth_challenge_present "$response"
}

detect_router_port() {
  router_ip=$1

  router_ip_is_valid "$router_ip" || {
    echo 'mndw: router IP is required' >&2
    return 1
  }

  if [ -n "$MNDW_ROUTER_PORT" ]; then
    port_is_valid "$MNDW_ROUTER_PORT" || {
      echo "mndw: invalid MNDW_ROUTER_PORT: $MNDW_ROUTER_PORT" >&2
      return 1
    }
    printf '%s\n' "$MNDW_ROUTER_PORT"
    return 0
  fi

  select_http_client || {
    echo 'mndw: router port detection requires curl or wget' >&2
    return 1
  }

  candidate_ports=$(list_router_listener_ports "$router_ip") || {
    echo 'mndw: unable to enumerate router TCP listeners' >&2
    return 1
  }

  [ -n "$candidate_ports" ] || {
    echo "mndw: no TCP listeners found on router IP $router_ip" >&2
    return 1
  }

  matched_ports=
  for candidate in $candidate_ports; do
    echo "[mndw] probing router /auth on $router_ip:$candidate" >&2
    if probe_router_auth "$router_ip" "$candidate"; then
      matched_ports="$matched_ports $candidate"
    fi
  done

  matched_count=0
  selected_port=
  for candidate in $matched_ports; do
    matched_count=$((matched_count + 1))
    selected_port=$candidate
  done

  if [ "$matched_count" -eq 1 ]; then
    printf '%s\n' "$selected_port"
    return 0
  fi

  if [ "$matched_count" -gt 1 ]; then
    echo "mndw: multiple router /auth listeners found on $router_ip:$matched_ports; set MNDW_ROUTER_PORT" >&2
    return 1
  fi

  echo "mndw: no router /auth listener found on $router_ip; candidates: $candidate_ports; set MNDW_ROUTER_PORT" >&2
  return 1
}

usage() {
  echo 'usage: mndw-router-port.sh detect ROUTER_IP' >&2
}

case "${1:-}" in
  detect)
    [ "$#" -eq 2 ] || {
      usage
      exit 2
    }
    detect_router_port "$2"
    ;;
  *)
    usage
    exit 2
    ;;
esac
