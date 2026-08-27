#!/bin/sh
set -eu

# shellcheck disable=SC1007
SCRIPT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/verify-entware-user-plugins.sh

sh -n "$SCRIPT"
help=$(sh "$SCRIPT" help)

for check in preflight upgrade remove-reinstall collision override; do
  printf '%s\n' "$help" | grep -F "$check"
done

force_reinstall="opkg --force-reinstall install \"\$ipk_path\""
override_dispatch="mndw_override \"\${1:-}\""
grep -F "$force_reinstall" "$SCRIPT"
grep -F "$override_dispatch" "$SCRIPT"

printf 'verify-entware-user-plugins helper smoke test: PASS\n'
