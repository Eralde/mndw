#!/bin/sh
set -eu

runtime_dir=${MNDW_PLUGIN_RUNTIME_DIR:-${MNDW_MWSD_RUNTIME_DIR:-${MWSD_RUNTIME_DIR:-/opt/var/run/mndw-mws-map-page}}}
pidfile="$runtime_dir/mwsd.pid"
if [ ! -f "$pidfile" ]; then
  exit 0
fi
pid=$(cat "$pidfile" 2>/dev/null || true)
if [ -n "$pid" ]; then
  kill "$pid" 2>/dev/null || true
fi
rm -f "$pidfile" "$runtime_dir/mwsd.sock"
