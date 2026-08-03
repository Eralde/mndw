#!/bin/sh
set -eu
base_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_id=${QUERY_STRING:-}
node_id=${node_id#nodeId=}
case "$node_id" in
  ''|*'&'*|*'='*) node_id= ;;
esac
exec "$base_dir/mwsd-client" snapshot "$node_id"
