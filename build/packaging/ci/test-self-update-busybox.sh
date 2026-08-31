#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
helper="$repo_root/build/packaging/files/opt/share/www/mndw/bin/mndw-self-update.sh"

fail() {
  echo "self-update helper test failed: $*" >&2
  exit 1
}

[ -f "$helper" ] || fail "helper missing: $helper"
sh -n "$helper" || fail 'helper syntax check failed'

root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-self-update-test.XXXXXX")
trap 'rm -rf "$root"' EXIT HUP INT TERM

fake_bin="$root/bin"
fake_opkg="$fake_bin/opkg"
mkdir -p "$fake_bin"
cat > "$fake_opkg" <<'EOF'
#!/bin/sh
set -eu

if { : >&3; } 2>/dev/null; then
  echo 'fd-3-leaked' >> "$OPKG_LOG"
fi
printf '%s\n' "$*" >> "$OPKG_LOG"

if [ "${FAIL_OPKG:-0}" = '1' ]; then
  exit 1
fi
EOF
chmod 755 "$fake_opkg"

new_case() {
  case_root="$root/case-$1"
  state="$case_root/state"
  cache="$case_root/cache"
  rollback="$case_root/rollback"
  marker="$case_root/self-update.json"
  failure="$case_root/self-update.failure"
  opkg_log="$case_root/opkg.log"
  mkdir -p "$state" "$cache" "$rollback"
  : > "$opkg_log"
}

run_helper() {
  MNDW_STATE_DIR="$state" \
  MNDW_CACHE_DIR="$cache" \
  MNDW_ROLLBACK_DIR="$rollback" \
  MNDW_MARKER="$marker" \
  MNDW_FAILURE="$failure" \
  MNDW_COPY="${MNDW_COPY:-cp}" \
  MNDW_MOVE="${MNDW_MOVE:-mv}" \
  MNDW_CAPTURE_MKDIR="${MNDW_CAPTURE_MKDIR:-mkdir}" \
  MNDW_WRITE_VERSION="${MNDW_WRITE_VERSION:-}" \
  OPKG="$fake_opkg" \
  OPKG_LOG="$opkg_log" \
  sh "$helper" "$@" 3>"$state/self-update.lock"
}

assert_line() {
  grep -Fx "$1" "$2" >/dev/null || fail "missing line '$1' in $2"
}

assert_no_line() {
  if grep -Fx "$1" "$2" >/dev/null; then
    fail "unexpected line '$1' in $2"
  fi
}

new_case update
touch "$cache/mndw_0.0.3_mipsel-3.4.ipk" "$cache/mndw_0.0.4_mipsel-3.4.ipk" "$state/mndw-0.0.5.ipk"
touch "$marker" "$failure"
run_helper update 0.0.3 0.0.5 "$state/mndw-0.0.5.ipk"
assert_line "install $state/mndw-0.0.5.ipk" "$opkg_log"
assert_no_line fd-3-leaked "$opkg_log"
[ "$(cat "$rollback/version")" = '0.0.3' ] || fail 'wrong rollback version'
[ -f "$rollback/mndw-0.0.3.ipk" ] || fail 'rollback IPK missing'
[ ! -e "$state/mndw-0.0.5.ipk" ] || fail 'pending IPK was not removed'
[ ! -e "$marker" ] || fail 'marker was not cleared'
[ ! -e "$failure" ] || fail 'failure was not cleared'

new_case revert
touch "$rollback/mndw-0.0.3.ipk"
printf '%s\n' 0.0.3 > "$rollback/version"
run_helper revert 0.0.5 0.0.3 "$rollback/mndw-0.0.3.ipk"
assert_line "install --force-reinstall --force-downgrade $rollback/mndw-0.0.3.ipk" "$opkg_log"
assert_no_line fd-3-leaked "$opkg_log"
[ -f "$rollback/mndw-0.0.3.ipk" ] || fail 'revert removed rollback IPK'

run_capture_failure() {
  case_name=$1
  override_name=$2
  override_value=$3
  new_case "$case_name"
  touch "$state/mndw-0.0.5.ipk"
  eval "$override_name=\"$override_value\""
  run_helper update 0.0.3 0.0.5 "$state/mndw-0.0.5.ipk"
  unset "$override_name"
  assert_line "install $state/mndw-0.0.5.ipk" "$opkg_log"
  [ ! -e "$rollback/version" ] || fail "$case_name left rollback pointer"
  [ ! -e "$rollback/mndw-0.0.3.ipk" ] || fail "$case_name left rollback IPK"
  [ "$(find "$rollback" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" = 0 ] || fail "$case_name left temp files"
}

fail_mkdir="$fake_bin/fail-mkdir"
fail_copy="$fake_bin/fail-copy"
fail_move="$fake_bin/fail-move"
fail_write="$fake_bin/fail-write"
for command in "$fail_mkdir" "$fail_copy" "$fail_move" "$fail_write"; do
  cat > "$command" <<'EOF'
#!/bin/sh
exit 1
EOF
  chmod 755 "$command"
done

run_capture_failure capture-dir MNDW_CAPTURE_MKDIR "$fail_mkdir"
run_capture_failure copy MNDW_COPY "$fail_copy"
run_capture_failure rename MNDW_MOVE "$fail_move"
run_capture_failure pointer-write MNDW_WRITE_VERSION "$fail_write"

new_case missing-update
if run_helper update 0.0.3 0.0.5 "$state/missing.ipk"; then
  fail 'missing update unexpectedly succeeded'
fi
[ "$(cat "$failure")" = 'update-missing' ] || fail 'wrong missing update failure code'
[ "$(wc -l < "$opkg_log" | tr -d ' ')" = 0 ] || fail 'missing update invoked opkg'

run_no_cache_case() {
  case_name=$1
  new_case "$case_name"
  touch "$state/mndw-0.0.5.ipk"
  if [ "$case_name" = multiple-cache ]; then
    touch "$cache/mndw_0.0.3_aarch64-3.10.ipk" "$cache/mndw_0.0.3_mipsel-3.4.ipk"
  fi
  run_helper update 0.0.3 0.0.5 "$state/mndw-0.0.5.ipk"
  assert_line "install $state/mndw-0.0.5.ipk" "$opkg_log"
  [ ! -e "$rollback/version" ] || fail "$case_name left rollback pointer"
  [ ! -e "$rollback/mndw-0.0.3.ipk" ] || fail "$case_name left rollback IPK"
}

run_no_cache_case no-cache
run_no_cache_case multiple-cache

new_case failed-install
touch "$cache/mndw_0.0.3_aarch64-3.10.ipk" "$state/mndw-0.0.5.ipk"
if FAIL_OPKG=1 run_helper update 0.0.3 0.0.5 "$state/mndw-0.0.5.ipk"; then
  fail 'failed install unexpectedly succeeded'
fi
[ "$(cat "$failure")" = 'opkg-install-failed' ] || fail 'wrong install failure code'
[ ! -e "$state/mndw-0.0.5.ipk" ] || fail 'failed install left pending IPK'
assert_no_line fd-3-leaked "$opkg_log"

new_case failed-revert
touch "$rollback/mndw-0.0.3.ipk"
if FAIL_OPKG=1 run_helper revert 0.0.5 0.0.3 "$rollback/mndw-0.0.3.ipk"; then
  fail 'failed revert unexpectedly succeeded'
fi
[ "$(cat "$failure")" = 'opkg-revert-failed' ] || fail 'wrong revert failure code'
[ -f "$rollback/mndw-0.0.3.ipk" ] || fail 'failed revert removed rollback IPK'
assert_no_line fd-3-leaked "$opkg_log"

echo 'self-update helper tests passed'
