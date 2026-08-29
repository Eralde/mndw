#!/bin/sh

# WHATWG Fetch bad-port entries within mndw's 99..199 candidate range.
browser_blocks_port() {
  case "$1" in
    101|102|103|104|109|110|111|113|115|117|119|123|135|137|139|143|161|179)
      return 0
      ;;
  esac

  return 1
}

extract_configured_ports() {
  awk '
    {
      line = $0
      sub(/[[:space:]]*#.*/, "", line)
    }
    line ~ /^[[:space:]]*server\.port[[:space:]]*(:=|=)[[:space:]]*[0-9]+[[:space:]]*$/ {
      sub(/^[[:space:]]*server\.port[[:space:]]*(:=|=)[[:space:]]*/, "", line)
      sub(/[[:space:]]*$/, "", line)
      if (line ~ /^[0-9]+$/) {
        port = line + 0
        if (port >= 99 && port <= 199) print port
      }
      next
    }
    line ~ /\$SERVER\["socket"\][[:space:]]*==[[:space:]]*"[^"[:space:]]*:[0-9]+"[[:space:]]*\{/ {
      sub(/^.*==[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*\{.*$/, "", line)
      sub(/^.*:/, "", line)
      if (line ~ /^[0-9]+$/) {
        port = line + 0
        if (port >= 99 && port <= 199) print port
      }
    }
  '
}

port_is_listed() {
  listed_port=$1
  list_file=$2

  [ -r "$list_file" ] || return 1
  grep -E -q "^((tcp4|tcp6)\\|)?$listed_port$" "$list_file"
}

scan_configured_ports() {
  foreign_file=$1
  owned_file=$2

  if [ -e "$MNDW_LIGHTTPD_CONFD" ]; then
    [ -d "$MNDW_LIGHTTPD_CONFD" ] && [ -r "$MNDW_LIGHTTPD_CONFD" ] && [ -x "$MNDW_LIGHTTPD_CONFD" ] || {
      echo "mndw: cannot inspect lighttpd config directory: $MNDW_LIGHTTPD_CONFD" >&2
      return 1
    }

    for config_file in "$MNDW_LIGHTTPD_CONFD"/*.conf; do
      [ -e "$config_file" ] || continue
      [ -f "$config_file" ] && [ -r "$config_file" ] || {
        echo "mndw: cannot read lighttpd config: $config_file" >&2
        return 1
      }
      [ "${config_file##*/}" = '81-mndw.conf' ] && continue
      extract_configured_ports < "$config_file" >> "$foreign_file" || return 1
    done
  fi

  if [ -e "$MNDW_RUNTIME_CONF" ]; then
    [ -f "$MNDW_RUNTIME_CONF" ] && [ -r "$MNDW_RUNTIME_CONF" ] || {
      echo "mndw: cannot read lighttpd config: $MNDW_RUNTIME_CONF" >&2
      return 1
    }
    extract_configured_ports < "$MNDW_RUNTIME_CONF" >> "$owned_file" || return 1
  fi
}

append_printed_ports_when_unowned() {
  persisted_port=$1
  foreign_file=$2
  printed_config="$MNDW_TMP_ROOT/lighttpd-printed-config.$$"

  [ -z "$persisted_port" ] || return 0
  mkdir -p "$MNDW_TMP_ROOT" || return 1

  if "$MNDW_LIGHTTPD_BIN" -p -f "$MNDW_LIGHTTPD_CONF" > "$printed_config" 2>> "$MNDW_PROBE_LOG"; then
    extract_configured_ports < "$printed_config" >> "$foreign_file"
    result=$?
    rm -f "$printed_config"
    printed_config=
    return $result
  fi

  rm -f "$printed_config"
  printed_config=
  echo '[mndw] warning: lighttpd print-config supplement unavailable' >> "$MNDW_PROBE_LOG"
  return 0
}

normalize_evidence_file() {
  evidence_file=$1
  sorted_file="$evidence_file.sorted"
  sort_command=${MNDW_EVIDENCE_SORT:-sort}
  mv_command=${MNDW_EVIDENCE_MV:-mv}

  "$sort_command" -u "$evidence_file" > "$sorted_file" || {
    rm -f "$sorted_file"
    return 1
  }
  "$mv_command" "$sorted_file" "$evidence_file" || {
    rm -f "$sorted_file"
    return 1
  }
}
