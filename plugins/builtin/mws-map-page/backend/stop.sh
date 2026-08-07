#!/bin/sh
set -eu

runtime_dir=${MNDW_PLUGIN_RUNTIME_DIR:-${MNDW_MWSD_RUNTIME_DIR:-${MWSD_RUNTIME_DIR:-/opt/var/run/mndw-mws-map-page}}}
pidfile="$runtime_dir/mwsd.pid"
if [ ! -f "$pidfile" ]; then
  exit 0
fi
pid=$(cat "$pidfile" 2>/dev/null || true)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  remaining=10
  while [ "$remaining" -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 1
    remaining=$((remaining - 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    current_pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ "$current_pid" = "$pid" ]; then
      kill -KILL "$pid" 2>/dev/null || true
      wait_forced=2
      while [ "$wait_forced" -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 1
        wait_forced=$((wait_forced - 1))
      done
    fi
  fi
fi
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  exit 1
fi
current_pid=$(cat "$pidfile" 2>/dev/null || true)
if [ -n "$current_pid" ] && [ "$current_pid" != "$pid" ]; then
  exit 1
fi
rm -f "$pidfile" "$runtime_dir/mwsd.sock"
