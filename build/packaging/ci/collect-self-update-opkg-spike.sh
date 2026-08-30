#!/bin/sh
# Collect Task 0 opkg evidence on a device.
#
# This script is POSIX/BusyBox sh compatible. It writes one report that can be
# downloaded after the run. Installing the downloaded IPK may restart mndwd;
# require MNDW_CONFIRM_INSTALL=YES explicitly before that step is performed.
set -u

REPORT_PATH=${1:-${MNDW_REPORT_PATH:-/tmp/mndw-self-update-opkg-spike.$$.txt}}
STATE_DIR=${MNDW_STATE_DIR:-/opt/var/mndw}
CACHE_DIR=${MNDW_CACHE_DIR:-$STATE_DIR/opkg-cache}
OPKG=${OPKG:-opkg}
MKTEMP=${MNDW_MKTEMP:-mktemp}
FIND=${MNDW_FIND:-find}

report_parent=${REPORT_PATH%/*}
[ "$report_parent" = "$REPORT_PATH" ] && report_parent=.

if ! mkdir -p "$report_parent" 2>/dev/null; then
  echo "cannot create report directory: $report_parent" >&2
  exit 1
fi

if ! : > "$REPORT_PATH"; then
  echo "cannot write report: $REPORT_PATH" >&2
  exit 1
fi

work_dir=
failed=0
install_attempted=0
downloaded_ipk=
target_version=
feed_arch=

cleanup() {
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
  rm -f \
    "$REPORT_PATH.firmware" "$REPORT_PATH.cwd" "$REPORT_PATH.opkg-version" \
    "$REPORT_PATH.architecture" "$REPORT_PATH.update" "$REPORT_PATH.installed-before" \
    "$REPORT_PATH.upgradable" "$REPORT_PATH.download-cwd" "$REPORT_PATH.download" \
    "$REPORT_PATH.download-files" "$REPORT_PATH.downloaded-ipks" "$REPORT_PATH.install" \
    "$REPORT_PATH.installed-after"
}

trap cleanup EXIT HUP INT TERM

log_command() {
  printf '\n$' >> "$REPORT_PATH"
  for argument in "$@"; do
    printf ' %s' "$argument" >> "$REPORT_PATH"
  done
  printf '\n' >> "$REPORT_PATH"
}

run_capture() {
  label=$1
  output_file=$2
  shift 2

  printf '\n[%s]\n' "$label" >> "$REPORT_PATH"
  log_command "$@"
  "$@" > "$output_file" 2>&1
  status=$?
  cat "$output_file" >> "$REPORT_PATH"
  printf '[exit %s]\n' "$status" >> "$REPORT_PATH"
  return "$status"
}

run_capture_in_dir() {
  label=$1
  output_file=$2
  cwd=$3
  shift 3

  printf '\n[%s]\n' "$label" >> "$REPORT_PATH"
  log_command "(cd $cwd && $*)"
  (cd "$cwd" && "$@") > "$output_file" 2>&1
  status=$?
  cat "$output_file" >> "$REPORT_PATH"
  printf '[exit %s]\n' "$status" >> "$REPORT_PATH"
  return "$status"
}

record_cache() {
  label=$1
  printf '\n[%s]\n' "$label" >> "$REPORT_PATH"
  if [ -d "$CACHE_DIR" ]; then
    log_command "$FIND" "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type f -name 'mndw_*.ipk' -print
    "$FIND" "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type f -name 'mndw_*.ipk' -print >> "$REPORT_PATH" 2>&1
    printf '[exit %s]\n' "$?" >> "$REPORT_PATH"
  else
    printf 'cache directory absent: %s\n' "$CACHE_DIR" >> "$REPORT_PATH"
  fi
}

{
  printf '%s\n' '# mndw self-update opkg capability spike'
  printf '%s\n' '# WARNING: MNDW_CONFIRM_INSTALL=YES permits package installation and daemon restart.'
  printf 'startedAt: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
  printf 'stateDir: %s\n' "$STATE_DIR"
  printf 'cacheDir: %s\n' "$CACHE_DIR"
  printf 'reportPath: %s\n' "$REPORT_PATH"
} >> "$REPORT_PATH"

if ! mkdir -p "$STATE_DIR"; then
  printf 'state directory creation failed: %s\n' "$STATE_DIR" >> "$REPORT_PATH"
  failed=1
fi

if [ -r /etc/version ]; then
  run_capture 'firmware (/etc/version)' "$REPORT_PATH.firmware" cat /etc/version || failed=1
else
  printf '\n[firmware (/etc/version)]\nnot present\n' >> "$REPORT_PATH"
fi

run_capture 'command cwd' "$REPORT_PATH.cwd" pwd || failed=1
run_capture 'opkg --version' "$REPORT_PATH.opkg-version" "$OPKG" --version || failed=1
run_capture 'opkg print-architecture' "$REPORT_PATH.architecture" "$OPKG" print-architecture || failed=1
run_capture 'opkg update' "$REPORT_PATH.update" "$OPKG" update || failed=1
run_capture 'opkg list-installed mndw (before)' "$REPORT_PATH.installed-before" "$OPKG" list-installed mndw || failed=1
run_capture 'opkg list-upgradable' "$REPORT_PATH.upgradable" "$OPKG" list-upgradable || failed=1
record_cache 'opkg cache (before)'

installed_version=$(awk '$1 == "mndw" {if ($2 == "-") print $3; else print $2; exit}' \
  "$REPORT_PATH.installed-before" 2>/dev/null || true)
row_count=$(awk '$1 == "mndw" {count++} END {print count + 0}' "$REPORT_PATH.upgradable" 2>/dev/null || echo 0)
valid_row_count=$(awk -F ' - ' '$1 == "mndw" && NF == 3 {count++} END {print count + 0}' \
  "$REPORT_PATH.upgradable" 2>/dev/null || echo 0)

if [ "$row_count" -ne 1 ] || [ "$valid_row_count" -ne 1 ]; then
  printf '\ncandidate: unable to derive exactly one parseable mndw row (rows=%s, parseable=%s)\n' \
    "$row_count" "$valid_row_count" >> "$REPORT_PATH"
  failed=1
else
  candidate_current=$(awk -F ' - ' '$1 == "mndw" {print $2; exit}' "$REPORT_PATH.upgradable")
  target_version=$(awk -F ' - ' '$1 == "mndw" {print $3; exit}' "$REPORT_PATH.upgradable")
  printf '\ncandidate.currentVersion: %s\n' "$candidate_current" >> "$REPORT_PATH"
  printf 'candidate.targetVersion: %s\n' "$target_version" >> "$REPORT_PATH"

  if [ "$candidate_current" != "$installed_version" ]; then
    printf 'candidate: installed/current mismatch (%s != %s)\n' "$installed_version" "$candidate_current" >> "$REPORT_PATH"
    failed=1
  fi
fi

feed_arch=$(awk '$1 == "arch" && ($2 == "aarch64-3.10" || $2 == "mips-3.4" || $2 == "mipsel-3.4") {print $2; exit}' \
  "$REPORT_PATH.architecture" 2>/dev/null || true)

if [ -z "$feed_arch" ]; then
  printf 'architecture: no supported opkg architecture found\n' >> "$REPORT_PATH"
  failed=1
else
  printf 'selectedArchitecture: %s\n' "$feed_arch" >> "$REPORT_PATH"
fi

if [ -n "$target_version" ] && [ -n "$feed_arch" ]; then
  if ! work_dir=$($MKTEMP -d "$STATE_DIR/opkg-spike.XXXXXX" 2>/dev/null); then
    work_dir="$STATE_DIR/opkg-spike.$$"
    if ! (umask 077 && mkdir "$work_dir"); then
      printf 'download directory creation failed\n' >> "$REPORT_PATH"
      failed=1
      work_dir=
    fi
  fi
fi

if [ -n "$work_dir" ]; then
  run_capture_in_dir 'download working directory' "$REPORT_PATH.download-cwd" "$work_dir" pwd || failed=1
  run_capture_in_dir 'opkg download mndw' "$REPORT_PATH.download" "$work_dir" "$OPKG" download mndw || failed=1
  run_capture 'download directory contents' "$REPORT_PATH.download-files" "$FIND" "$work_dir" -mindepth 1 -maxdepth 1 -print || failed=1
  run_capture 'downloaded mndw IPKs' "$REPORT_PATH.downloaded-ipks" "$FIND" "$work_dir" -mindepth 1 -maxdepth 1 -type f -name 'mndw_*.ipk' -print || failed=1

  ipk_count=$(wc -l < "$REPORT_PATH.downloaded-ipks" | tr -d ' ')
  if [ "$ipk_count" -ne 1 ]; then
    printf 'download: expected exactly one regular mndw IPK, found %s\n' "$ipk_count" >> "$REPORT_PATH"
    failed=1
  else
    downloaded_ipk=$(sed -n '1p' "$REPORT_PATH.downloaded-ipks")
    downloaded_name=${downloaded_ipk##*/}
    expected_name=mndw_${target_version}_${feed_arch}.ipk
    printf 'downloadedIPK: %s\n' "$downloaded_ipk" >> "$REPORT_PATH"
    printf 'expectedIPK: %s\n' "$expected_name" >> "$REPORT_PATH"

    if [ "$downloaded_name" != "$expected_name" ] || [ ! -f "$downloaded_ipk" ] || [ -L "$downloaded_ipk" ]; then
      printf 'download: filename or file type mismatch\n' >> "$REPORT_PATH"
      failed=1
    fi
  fi

  if [ "${MNDW_CONFIRM_INSTALL:-}" != YES ]; then
    printf '\ninstall: SKIPPED; rerun with MNDW_CONFIRM_INSTALL=YES to install and restart daemon\n' >> "$REPORT_PATH"
    failed=1
  elif [ -n "$downloaded_ipk" ] && [ -f "$downloaded_ipk" ]; then
    install_attempted=1
    if run_capture 'opkg install downloaded exact path' "$REPORT_PATH.install" "$OPKG" install "$downloaded_ipk"; then
      run_capture 'opkg list-installed mndw (after)' "$REPORT_PATH.installed-after" "$OPKG" list-installed mndw || failed=1
      installed_after=$(awk '$1 == "mndw" {if ($2 == "-") print $3; else print $2; exit}' \
        "$REPORT_PATH.installed-after" 2>/dev/null || true)
      printf 'installedVersionAfter: %s\n' "$installed_after" >> "$REPORT_PATH"
      if [ "$installed_after" != "$target_version" ]; then
        printf 'install: installed version does not match downloaded target\n' >> "$REPORT_PATH"
        failed=1
      fi
    else
      failed=1
    fi
  fi

  record_cache 'opkg cache (after)'
fi

if [ "$failed" -eq 0 ] && [ "$install_attempted" -eq 1 ]; then
  result=PASS
  exit_code=0
else
  result=FAIL
  exit_code=1
fi

printf '\nRESULT: %s\n' "$result" >> "$REPORT_PATH"
printf 'REPORT: %s\n' "$REPORT_PATH" >> "$REPORT_PATH"
printf 'Report: %s\n' "$REPORT_PATH"
printf 'Result: %s\n' "$result"
exit "$exit_code"
