#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
evidence_helper="$repo_root/build/packaging/files/opt/share/www/mndw/bin/mndw-lighttpd-port-evidence.sh"
port_helper="$repo_root/build/packaging/files/opt/share/www/mndw/bin/mndw-lighttpd-port.sh"
router_port_helper="$repo_root/build/packaging/files/opt/share/www/mndw/bin/mndw-router-port.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-port-busybox.XXXXXX")

cleanup() {
  rm -rf "$fixture_root"
}

trap cleanup EXIT HUP INT TERM

fail() {
  echo "lighttpd port BusyBox test failed: $*" >&2
  exit 1
}

assert_eq() {
  expected=$1
  actual=$2

  [ "$actual" = "$expected" ] || fail "expected [$expected], got [$actual]"
}

assert_file_contains() {
  needle=$1
  file=$2

  grep -F -q "$needle" "$file" || fail "[$file] does not contain [$needle]"
}

bin_dir="$fixture_root/bin"
proc_root="$fixture_root/proc"
conf_dir="$fixture_root/etc/lighttpd/conf.d"
runtime_conf="$fixture_root/var/lib/mndw/lighttpd-runtime.conf"
foreign_file="$fixture_root/foreign"
owned_file="$fixture_root/owned"
mkdir -p "$bin_dir" "$proc_root/net" "$conf_dir" "$(dirname "$runtime_conf")"
printf '  sl  local_address rem_address   st\n' > "$proc_root/net/tcp"
printf '  sl  local_address rem_address   st\n' > "$proc_root/net/tcp6"

MNDW_ROOT="$fixture_root"
MNDW_LIGHTTPD_CONFD="$conf_dir"
MNDW_RUNTIME_CONF="$runtime_conf"
MNDW_TMP_ROOT="$fixture_root/tmp/mndw"
MNDW_PROBE_LOG="$fixture_root/tmp/mndw/probe.log"
export MNDW_ROOT MNDW_LIGHTTPD_CONFD MNDW_RUNTIME_CONF MNDW_TMP_ROOT MNDW_PROBE_LOG

. "$evidence_helper"

for port in 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179; do
  browser_blocks_port "$port" || fail "port $port was not classified as browser-blocked"
done
for port in 99 100 105 199; do
  browser_blocks_port "$port" && fail "port $port was incorrectly classified as browser-blocked"
done

extracted=$(printf '%s\n' \
  'server.port:=99 # preferred' \
  'server.port = 98' \
  'server.port = 200' \
  '$SERVER["socket"] == "127.0.0.1:100" {' \
  '$SERVER["socket"] == "router.local:101" {' \
  '$SERVER["socket"] == "*:102" {' \
  '$SERVER["socket"] == "[::]:199" {' | extract_configured_ports)
assert_eq '99
100
101
102
199' "$extracted"

printf '%s\n' \
  'server.port := 99' \
  '$SERVER["socket"] == ":100" {' \
  'server.port = 200' > "$conf_dir/80-w4s.conf"
printf '%s\n' \
  'server.port = 101' \
  '$SERVER["socket"] == ":101" {' > "$conf_dir/81-mndw.conf"
printf '%s\n' 'server.port = 102' > "$runtime_conf"
: > "$foreign_file"
: > "$owned_file"
scan_configured_ports "$foreign_file" "$owned_file"
normalize_evidence_file "$foreign_file"
normalize_evidence_file "$owned_file"
assert_eq '100
99' "$(sed '/^$/d' "$foreign_file")"
assert_eq '102' "$(sed '/^$/d' "$owned_file")"

MNDW_LIGHTTPD_CONFD="$fixture_root/etc/lighttpd/absent"
export MNDW_LIGHTTPD_CONFD
: > "$foreign_file"
: > "$owned_file"
scan_configured_ports "$foreign_file" "$owned_file"
[ ! -s "$foreign_file" ] || fail 'absent conf.d produced foreign evidence'

MNDW_LIGHTTPD_CONFD="$fixture_root/etc/lighttpd/not-a-directory"
export MNDW_LIGHTTPD_CONFD
printf '%s\n' 'not a directory' > "$MNDW_LIGHTTPD_CONFD"
if scan_configured_ports "$foreign_file" "$owned_file" > "$fixture_root/error" 2>&1; then
  fail 'non-directory conf.d unexpectedly passed'
fi
assert_file_contains "cannot inspect lighttpd config directory: $MNDW_LIGHTTPD_CONFD" "$fixture_root/error"

MNDW_LIGHTTPD_CONFD="$conf_dir"
export MNDW_LIGHTTPD_CONFD
mkdir "$conf_dir/bad.conf"
if scan_configured_ports "$foreign_file" "$owned_file" > "$fixture_root/error" 2>&1; then
  fail 'non-regular config unexpectedly passed'
fi
assert_file_contains "cannot read lighttpd config: $conf_dir/bad.conf" "$fixture_root/error"
rmdir "$conf_dir/bad.conf"

fail_sort="$bin_dir/fail-sort"
fail_mv="$bin_dir/fail-mv"
printf '%s\n' '#!/bin/sh' 'exit 1' > "$fail_sort"
printf '%s\n' '#!/bin/sh' 'exit 1' > "$fail_mv"
chmod 755 "$fail_sort" "$fail_mv"
printf '%s\n' '99' > "$foreign_file"
MNDW_EVIDENCE_SORT="$fail_sort"
export MNDW_EVIDENCE_SORT
if normalize_evidence_file "$foreign_file"; then
  fail 'sort failure unexpectedly passed'
fi
[ ! -e "$foreign_file.sorted" ] || fail 'sort failure left sorted residue'
unset MNDW_EVIDENCE_SORT
MNDW_EVIDENCE_MV="$fail_mv"
export MNDW_EVIDENCE_MV
if normalize_evidence_file "$foreign_file"; then
  fail 'mv failure unexpectedly passed'
fi
[ ! -e "$foreign_file.sorted" ] || fail 'mv failure left sorted residue'
unset MNDW_EVIDENCE_MV

printf '%s\n' '#!/bin/sh' 'exit 0' > "$bin_dir/netstat"
printf '%s\n' '#!/bin/sh' 'exit 2' > "$bin_dir/lighttpd"
chmod 755 "$bin_dir/netstat" "$bin_dir/lighttpd"
MNDW_LIGHTTPD_CONFD="$conf_dir"
MNDW_RUNTIME_CONF="$fixture_root/var/lib/mndw/no-runtime.conf"
MNDW_CONFIG_FILE="$fixture_root/etc/mndw.conf"
MNDW_PROC_ROOT="$proc_root"
MNDW_NETSTAT="$bin_dir/netstat"
MNDW_LIGHTTPD_BIN="$bin_dir/lighttpd"
MNDW_LIGHTTPD_CONF="$fixture_root/etc/lighttpd/lighttpd.conf"
MNDW_PROBE_LOG="$fixture_root/tmp/mndw/port-helper.log"
export MNDW_LIGHTTPD_CONFD MNDW_RUNTIME_CONF MNDW_CONFIG_FILE MNDW_PROC_ROOT MNDW_NETSTAT
export MNDW_LIGHTTPD_BIN MNDW_LIGHTTPD_CONF MNDW_PROBE_LOG
selected=$(sh "$port_helper" select-port)
assert_eq '105' "$selected"

printf '%s\n' '#!/bin/sh' \
  'cat <<EOF' \
  'tcp 0 0 127.0.0.1:9090 0.0.0.0:* LISTEN' \
  'tcp 0 0 0.0.0.0:99 0.0.0.0:* LISTEN' \
  'tcp 0 0 198.51.100.11:8081 0.0.0.0:* LISTEN' \
  'tcp 0 0 198.51.100.11:443 0.0.0.0:* LISTEN' \
  'EOF' > "$bin_dir/router-netstat"
printf '%s\n' '#!/bin/sh' \
  'case "$*" in' \
  '  *198.51.100.11:8081/auth*)' \
  '    printf "%s\\n" "HTTP/1.1 401 Unauthorized" "WWW-Authenticate: x-ndw4-interactive endpoint=\\"/auth\\""' \
  '    ;;' \
  'esac' > "$bin_dir/router-curl"
chmod 755 "$bin_dir/router-netstat" "$bin_dir/router-curl"
MNDW_NETSTAT="$bin_dir/router-netstat"
MNDW_CURL="$bin_dir/router-curl"
export MNDW_NETSTAT MNDW_CURL
selected=$(sh "$router_port_helper" detect 198.51.100.11)
assert_eq '8081' "$selected"

echo 'lighttpd port BusyBox tests passed'
