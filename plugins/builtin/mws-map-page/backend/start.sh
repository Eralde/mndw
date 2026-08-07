#!/bin/sh
set -eu

base_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_dir=${MNDW_PLUGIN_RUNTIME_DIR:-${MNDW_MWSD_RUNTIME_DIR:-${MWSD_RUNTIME_DIR:-/opt/var/run/mndw-mws-map-page}}}
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
pidfile="$runtime_dir/mwsd.pid"
socket="$runtime_dir/mwsd.sock"

if [ -f "$pidfile" ]; then
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
  rm -f "$pidfile" "$socket"
fi

MNDW_PLUGIN_RUNTIME_DIR="$runtime_dir" MWSD_RUNTIME_DIR="$runtime_dir" exec "$base_dir/mwsd" --runtime-dir "$runtime_dir" >/dev/null 2>&1 &
