#!/bin/sh

echo "Content-Type: application/json"
echo ""

/opt/bin/killall ttyd >/dev/null 2>&1

if [ $? -eq 0 ]; then
  echo '{"success": true}'
else
  echo '{"success": false}'
fi
