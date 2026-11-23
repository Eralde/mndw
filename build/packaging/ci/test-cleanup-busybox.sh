#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-cleanup-busybox.XXXXXX")
root="$tmp_root/root"
cleanup_script="$repo_root/build/packaging/files/opt/bin/mndw-cleanup"
daemon="$root/sbin/mndwd"
opkg="$tmp_root/opkg"
opkg_log="$tmp_root/opkg.log"

trap 'rm -rf "$tmp_root"' EXIT HUP INT TERM

mkdir -p "$root/sbin" "$root/var/lib/mndw"
printf 'data\n' > "$root/var/lib/mndw/state.json"
cat > "$daemon" <<'EOF'
#!/bin/sh
case " $* " in
  *" --print-plugin-packages "*) printf 'plugin-a cleanup-widget\n' ;;
esac
exit 0
EOF
cat > "$opkg" <<'EOF'
#!/bin/sh
case "${1:-}" in
  status) printf 'Package: mndw\nDepends: base-dep\n' ;;
  list-installed) printf 'plugin-a - 1.0\n' ;;
  remove) printf '%s %s\n' "$1" "$2" >> "$OPKG_LOG" ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$daemon" "$opkg"

cleanup_output=$(MNDW_ROOT="$root" MNDWD_BIN="$daemon" OPKG="$opkg" OPKG_LOG="$opkg_log" sh "$cleanup_script" --yes)
printf '%s\n' "$cleanup_output"

if ! printf '%s\n' "$cleanup_output" | awk '
  /^mndw cleanup will remove these existing files and directories:$/ { files = NR }
  /^  .*\/var\/lib\/mndw$/ { data = NR }
  /^After that you will be asked whether to remove these packages installed for user plugins:$/ { packages = NR }
  /^  plugin-a \(cleanup-widget\)$/ && plugin == 0 { plugin = NR }
  /feed key id is unresolved/ { key = NR }
  END {
    if (files > 0 && files < data && data < packages && packages < plugin && plugin < key) { exit 0 }
    exit 1
  }
'; then
  echo 'cleanup BusyBox gate saw plan or feed-key message in wrong order' >&2
  exit 1
fi

if [ -e "$root/var/lib/mndw" ]; then
  echo 'cleanup BusyBox gate left data behind' >&2
  exit 1
fi

if [ "$(cat "$opkg_log")" != 'remove plugin-a' ]; then
  echo 'cleanup BusyBox gate did not remove the filtered plugin package' >&2
  exit 1
fi

refused_root="$tmp_root/refused-root"
mkdir -p "$refused_root/var" "$refused_root/etc"
printf 'keep\n' > "$refused_root/var/marker"
printf '%s\n' 'DATA_DIR=$MNDW_ROOT/var/' > "$refused_root/etc/mndw.conf"
if refused_output=$(MNDW_ROOT="$refused_root" MNDWD_BIN="$daemon" OPKG="$opkg" OPKG_LOG="$tmp_root/refused-opkg.log" sh "$cleanup_script" --yes 2>&1); then
  refused_status=0
else
  refused_status=$?
fi

if [ "$refused_status" -ne 2 ]; then
  echo "cleanup BusyBox gate expected refused path status 2, got $refused_status" >&2
  exit 1
fi

printf '%s\n' "$refused_output" | awk '
  /^After that you will be asked whether to remove these packages installed for user plugins:$/ { packages = NR }
  /^  plugin-a \(cleanup-widget\)$/ && plugin == 0 { plugin = NR }
  /feed key id is unresolved/ { key = NR }
  /refusing cleanup path that overlaps shared directories:/ { refused = NR }
  END {
    if (packages > 0 && packages < plugin && plugin < key && key < refused) { exit 0 }
    exit 1
  }
' || {
  echo 'cleanup BusyBox gate saw refused-path message before the complete plan' >&2
  exit 1
}

if [ ! -e "$refused_root/var/marker" ]; then
  echo 'cleanup BusyBox gate removed a refused shared directory' >&2
  exit 1
fi

