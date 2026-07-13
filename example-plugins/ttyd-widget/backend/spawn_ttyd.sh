#!/bin/sh

echo "Content-Type: application/json"
echo ""

TTYD_BIN="/opt/bin/ttyd"
DAEMONIZE_BIN="/opt/bin/daemonize"
TTYD_PORT="7681"

if [ ! -x "$TTYD_BIN" ]; then
  echo '{"success": false, "error": "ttyd is not installed"}'
  exit 0
fi

if [ ! -x "$DAEMONIZE_BIN" ]; then
  echo '{"success": false, "error": "daemonize is not installed"}'
  exit 0
fi

NETSTAT_BIN="/opt/bin/netstat"
GREP_BIN="/opt/bin/grep"

if [ ! -x "$NETSTAT_BIN" ]; then
  NETSTAT_BIN="netstat"
fi

if [ ! -x "$GREP_BIN" ]; then
  GREP_BIN="grep"
fi

if "$NETSTAT_BIN" -tln 2>/dev/null | "$GREP_BIN" -q ":$TTYD_PORT "; then
  echo "{\"success\": true, \"port\": $TTYD_PORT}"
  exit 0
fi

if ! "$DAEMONIZE_BIN" "$TTYD_BIN" -p "$TTYD_PORT" -W ndmc; then
  echo '{"success": false, "error": "Failed to spawn ttyd"}'
  exit 0
fi

echo "{\"success\": true, \"port\": $TTYD_PORT}"
