#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT HUP INT TERM

sh -n "$repo_root/build/packaging/init/S70mndwd"
sh -n "$repo_root/build/packaging/files/opt/bin/mndw-cleanup"
sh -n "$repo_root/build/packaging/ipk/postinst"
sh -n "$repo_root/build/packaging/ipk/postrm"

if MNDW_ROOT="$fixture_root/root" MNDW_CONFIG_FILE="$fixture_root/missing.conf" \
  sh "$repo_root/build/packaging/init/S70mndwd" status > "$fixture_root/status.out" 2>&1; then
  status=0
else
  status=$?
fi

if [ "$status" -ne 3 ] || [ "$(cat "$fixture_root/status.out")" != 'mndwd is not running' ]; then
  echo "init status smoke expected exit 3 and not-running output, got exit $status" >&2
  cat "$fixture_root/status.out" >&2
  exit 1
fi
