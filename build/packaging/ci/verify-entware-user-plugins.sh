#!/bin/sh

# BusyBox/POSIX acceptance checks for durable user-plugin storage.
# Run as root on an Entware device during a maintenance window.

set -u

MNDW_ROOT=${MNDW_ROOT:-/opt}
MNDW_CONFIG_FILE=${MNDW_CONFIG_FILE:-$MNDW_ROOT/etc/mndw.conf}
MNDW_CHECK_DIR=${MNDW_CHECK_DIR:-/tmp/mndw-user-plugin-check}
MNDW_DEVICE_HOST=${MNDW_DEVICE_HOST:-127.0.0.1}
MNDW_IPK_NEW=${MNDW_IPK_NEW:-}
MNDW_IPK_COLLISION=${MNDW_IPK_COLLISION:-$MNDW_IPK_NEW}
MNDW_FAILURES=0

load_paths() {
  if [ -f "$MNDW_CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    . "$MNDW_CONFIG_FILE"
  fi

  : "${DATA_DIR:=$MNDW_ROOT/var/lib/mndw}"
  MNDW_USER_PLUGINS_DIR=${MNDW_USER_PLUGINS_DIR:-$DATA_DIR/user-plugins}
  MNDW_LEGACY_USER_PLUGINS_DIR=$MNDW_ROOT/share/www/mndw/user-plugins
  MNDW_PORT_FILE=${MNDW_PORT_FILE:-$DATA_DIR/frontend-port}
  MNDW_APP_ROOT=$MNDW_ROOT/share/www/mndw
  MNDW_MNDWD_INIT=${MNDW_MNDWD_INIT:-$MNDW_ROOT/etc/init.d/S70mndwd}
}

load_paths

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  MNDW_FAILURES=$((MNDW_FAILURES + 1))
}

note() {
  printf 'INFO: %s\n' "$1"
}

section() {
  printf '\n== %s ==\n' "$1"
}

filesystem_device() {
  df -P "$1" 2>/dev/null | awk 'NR > 1 {print $1; exit}'
}

print_path_metadata() {
  path=$1

  path_metadata=$(stat -c '%u:%g %a %n' "$path" 2>/dev/null || true)
  if [ -n "$path_metadata" ]; then
    printf '%s\n' "$path_metadata"
    return 0
  fi

  ls -ld "$path" 2>/dev/null || return 1
}

finish() {
  if [ "$MNDW_FAILURES" -eq 0 ]; then
    printf 'RESULT: PASS\n'
    return 0
  fi

  printf 'RESULT: FAIL (%s failure(s))\n' "$MNDW_FAILURES" >&2
  return 1
}

require_ipk() {
  ipk_path=$1

  if [ -z "$ipk_path" ]; then
    fail 'set MNDW_IPK_NEW or pass a newer IPK path as an argument'
    return 1
  fi

  if [ ! -f "$ipk_path" ]; then
    fail "IPK does not exist: $ipk_path"
    return 1
  fi

  return 0
}

make_plugin() {
  plugin_name=$1
  plugin_root=$2
  plugin_body=$3

  if [ -e "$plugin_root/$plugin_name" ]; then
    fail "probe plugin already exists: $plugin_root/$plugin_name"
    return 1
  fi

  if ! mkdir -p "$plugin_root/$plugin_name"; then
    fail "cannot create probe plugin: $plugin_root/$plugin_name"
    return 1
  fi

  printf '%s\n' "$plugin_body" > "$plugin_root/$plugin_name/index.js"
  return 0
}

check_daemon_path() {
  expected_path=$1
  daemon_pid=$(pidof mndwd 2>/dev/null | awk '{print $1}')

  if [ -z "$daemon_pid" ]; then
    fail 'mndwd is not running'
    return 1
  fi

  daemon_cmdline=$(tr '\000' ' ' < "/proc/$daemon_pid/cmdline" 2>/dev/null || true)
  printf 'mndwd command line: %s\n' "$daemon_cmdline"

  case "$daemon_cmdline" in
    *"--user-plugins-dir $expected_path"*)
      pass "mndwd uses $expected_path"
      ;;
    *)
      fail "mndwd does not use $expected_path"
      ;;
  esac
}

check_http_plugin() {
  plugin_name=$1
  expected_body=$2

  if ! command -v curl >/dev/null 2>&1; then
    fail 'curl is required for static HTTP verification'
    return 1
  fi

  if [ ! -r "$MNDW_PORT_FILE" ]; then
    fail "selected-port state is missing: $MNDW_PORT_FILE"
    return 1
  fi

  port=$(cat "$MNDW_PORT_FILE")
  case "$port" in
    ''|*[!0-9]*)
      fail "selected-port state is invalid: $port"
      return 1
      ;;
  esac

  mkdir -p "$MNDW_CHECK_DIR"
  headers_file=$MNDW_CHECK_DIR/$plugin_name.headers
  body_file=$MNDW_CHECK_DIR/$plugin_name.body
  plugin_url="http://$MNDW_DEVICE_HOST:$port/user-plugins/$plugin_name/index.js"

  if ! curl -fsS -D "$headers_file" -o "$body_file" "$plugin_url"; then
    fail "static plugin request failed: $plugin_url"
    return 1
  fi

  if grep -Ei '^Content-Type:.*(javascript|ecmascript)' "$headers_file" >/dev/null 2>&1; then
    pass "static plugin response has JavaScript MIME type: $plugin_url"
  else
    fail "static plugin response has no JavaScript MIME type: $plugin_url"
  fi

  if grep -Fx "$expected_body" "$body_file" >/dev/null 2>&1; then
    pass "static plugin response contains expected body"
  else
    fail "static plugin response body does not match expected probe content"
  fi
}

mndw_preflight() {
  MNDW_FAILURES=0
  load_paths
  section 'preflight, filesystem, and permissions'

  if [ "$(id -u 2>/dev/null || printf 1)" = '0' ]; then
    pass 'running as root'
  else
    fail 'run this check as root'
  fi

  if command -v opkg >/dev/null 2>&1; then
    opkg --version || true
    if opkg status mndw >/dev/null 2>&1; then
      pass 'mndw package is installed'
    else
      fail 'mndw package is not installed'
    fi
  else
    fail 'opkg is not available'
  fi

  share_device=$(filesystem_device "$MNDW_ROOT/share/www")
  data_device=$(filesystem_device "$MNDW_ROOT/var/lib")
  df -P "$MNDW_ROOT/share/www" "$MNDW_ROOT/var/lib" 2>/dev/null || true

  if [ -n "$share_device" ] && [ "$share_device" = "$data_device" ]; then
    pass '/opt/share/www and /opt/var/lib share a filesystem'
  else
    fail '/opt/share/www and /opt/var/lib are on different filesystems or stat failed'
  fi

  printf 'configured user-plugin root: %s\n' "$MNDW_USER_PLUGINS_DIR"
  for path in \
    "$MNDW_ROOT" \
    "$MNDW_ROOT/share" \
    "$MNDW_ROOT/share/www" \
    "$MNDW_ROOT/var" \
    "$MNDW_ROOT/var/lib" \
    "$MNDW_USER_PLUGINS_DIR"; do
    if [ -e "$path" ]; then
      if ! print_path_metadata "$path"; then
        fail "cannot inspect $path"
      fi
    else
      note "path does not exist yet: $path"
    fi
  done

  for service in mndwd; do
    service_pid=$(pidof "$service" 2>/dev/null | awk '{print $1}')
    if [ -n "$service_pid" ]; then
      printf '== %s pid=%s ==\n' "$service" "$service_pid"
      grep -E '^(Name|Uid|Gid):' "/proc/$service_pid/status" 2>/dev/null || true
      pass "$service is running"
    else
      fail "$service is not running"
    fi
  done

  finish
}

mndw_upgrade() {
  MNDW_FAILURES=0
  load_paths
  section 'upgrade migration and static serving'

  ipk_path=${1:-$MNDW_IPK_NEW}
  if ! require_ipk "$ipk_path"; then
    finish
    return 1
  fi

  plugin_name=mndw-opkg-upgrade-probe-$$
  plugin_body='export const probe = 1;'
  make_plugin "$plugin_name" "$MNDW_LEGACY_USER_PLUGINS_DIR" "$plugin_body" || {
    finish
    return 1
  }

  mkdir -p "$MNDW_CHECK_DIR"
  upgrade_log=$MNDW_CHECK_DIR/upgrade-$plugin_name.log
  if opkg install "$ipk_path" > "$upgrade_log" 2>&1; then
    pass "opkg install/upgrade completed: $ipk_path"
  else
    fail "opkg upgrade failed: $ipk_path"
    cat "$upgrade_log"
    finish
    return 1
  fi

  if [ -f "$MNDW_USER_PLUGINS_DIR/$plugin_name/index.js" ]; then
    pass 'legacy plugin was moved to the durable root'
  else
    fail 'legacy plugin was not moved to the durable root'
  fi

  if [ ! -e "$MNDW_LEGACY_USER_PLUGINS_DIR/$plugin_name" ]; then
    pass 'legacy plugin directory no longer exists'
  else
    fail 'legacy plugin directory still exists after upgrade'
  fi

  check_daemon_path "$MNDW_USER_PLUGINS_DIR"
  check_http_plugin "$plugin_name" "$plugin_body"
  finish
}

mndw_remove_reinstall() {
  MNDW_FAILURES=0
  load_paths
  section 'remove and reinstall preservation'

  ipk_path=${1:-$MNDW_IPK_NEW}
  if ! require_ipk "$ipk_path"; then
    finish
    return 1
  fi

  plugin_name=mndw-opkg-remove-probe-$$
  plugin_body='export const remove_probe = 1;'
  make_plugin "$plugin_name" "$MNDW_LEGACY_USER_PLUGINS_DIR" "$plugin_body" || {
    finish
    return 1
  }

  mkdir -p "$MNDW_CHECK_DIR"
  remove_log=$MNDW_CHECK_DIR/remove-$plugin_name.log
  if opkg remove mndw > "$remove_log" 2>&1; then
    pass 'opkg remove completed'
  else
    fail 'opkg remove failed'
    cat "$remove_log"
    finish
    return 1
  fi

  if [ -f "$MNDW_USER_PLUGINS_DIR/$plugin_name/index.js" ]; then
    pass 'postrm migrated the legacy plugin before app-root removal'
  else
    fail 'postrm did not preserve the legacy plugin'
  fi

  if [ ! -d "$MNDW_APP_ROOT" ]; then
    pass 'package-owned app root was removed'
  else
    fail 'package-owned app root still exists after remove'
  fi

  if opkg install "$ipk_path" > "$MNDW_CHECK_DIR/reinstall-$plugin_name.log" 2>&1; then
    pass 'opkg reinstall completed'
  else
    fail 'opkg reinstall failed'
    cat "$MNDW_CHECK_DIR/reinstall-$plugin_name.log"
    finish
    return 1
  fi

  if [ -f "$MNDW_USER_PLUGINS_DIR/$plugin_name/index.js" ]; then
    pass 'durable plugin survived reinstall'
  else
    fail 'durable plugin disappeared during reinstall'
  fi

  check_daemon_path "$MNDW_USER_PLUGINS_DIR"
  check_http_plugin "$plugin_name" "$plugin_body"
  finish
}

mndw_collision() {
  MNDW_FAILURES=0
  load_paths
  section 'collision abort and recovery'

  ipk_path=${1:-$MNDW_IPK_COLLISION}
  if ! require_ipk "$ipk_path"; then
    finish
    return 1
  fi

  plugin_name=mndw-opkg-collision-probe-$$
  legacy_file=$MNDW_LEGACY_USER_PLUGINS_DIR/$plugin_name/index.js
  durable_file=$MNDW_USER_PLUGINS_DIR/$plugin_name/index.js
  mkdir -p "${legacy_file%/*}" "${durable_file%/*}"
  printf 'legacy\n' > "$legacy_file"
  printf 'durable\n' > "$durable_file"

  mkdir -p "$MNDW_CHECK_DIR"
  collision_log=$MNDW_CHECK_DIR/collision-$plugin_name.log
  if opkg --force-reinstall install "$ipk_path" > "$collision_log" 2>&1; then
    fail 'collision upgrade unexpectedly succeeded'
    cat "$collision_log"
    finish
    return 1
  else
    pass 'collision caused opkg upgrade to abort'
  fi

  if grep -Fx 'legacy' "$legacy_file" >/dev/null 2>&1 && grep -Fx 'durable' "$durable_file" >/dev/null 2>&1; then
    pass 'both colliding copies remain unchanged'
  else
    fail 'collision changed or removed one of the copies'
  fi

  backup_dir=$MNDW_USER_PLUGINS_DIR/${plugin_name}.durable-backup-$$
  if mv "$MNDW_USER_PLUGINS_DIR/$plugin_name" "$backup_dir" && mv \
    "$MNDW_LEGACY_USER_PLUGINS_DIR/$plugin_name" "$MNDW_USER_PLUGINS_DIR/$plugin_name"; then
    rmdir "$MNDW_LEGACY_USER_PLUGINS_DIR" 2>/dev/null || true
    pass 'collision was physically resolved without overwriting either copy'
  else
    fail 'could not resolve disposable collision probe'
    finish
    return 1
  fi

  retry_log=$MNDW_CHECK_DIR/collision-retry-$plugin_name.log
  if opkg install "$ipk_path" > "$retry_log" 2>&1; then
    pass 'opkg upgrade succeeds after physical collision resolution'
  else
    fail 'opkg upgrade still fails after collision resolution'
    cat "$retry_log"
  fi

  if [ -f "$MNDW_USER_PLUGINS_DIR/$plugin_name/index.js" ] && \
    grep -Fx 'legacy' "$MNDW_USER_PLUGINS_DIR/$plugin_name/index.js" >/dev/null 2>&1; then
    pass 'legacy copy was retained after recovery'
  else
    fail 'legacy copy was not retained after recovery'
  fi

  check_daemon_path "$MNDW_USER_PLUGINS_DIR"
  check_http_plugin "$plugin_name" 'legacy'

  rm -rf "${MNDW_USER_PLUGINS_DIR:?}/$plugin_name" "${backup_dir:?}"
  finish
}

mndw_override() {
  MNDW_FAILURES=0
  load_paths
  section 'canonical override wiring'

  if ! command -v opkg >/dev/null 2>&1; then
    fail 'opkg is not available'
    finish
    return 1
  fi

  ipk_path=${1:-$MNDW_IPK_NEW}
  if ! require_ipk "$ipk_path"; then
    finish
    return 1
  fi

  if [ ! -f "$MNDW_CONFIG_FILE" ]; then
    config_existed=0
    mkdir -p "${MNDW_CONFIG_FILE%/*}"
    : > "$MNDW_CONFIG_FILE"
  else
    config_existed=1
  fi

  mkdir -p "$MNDW_CHECK_DIR"
  config_backup=$MNDW_CHECK_DIR/mndw.conf.override-backup
  if ! cp -p "$MNDW_CONFIG_FILE" "$config_backup"; then
    fail "cannot back up $MNDW_CONFIG_FILE"
    finish
    return 1
  fi

  override_root=$MNDW_ROOT/var/lib/mndw-user-plugins-override-$$
  if [ -e "$override_root" ]; then
    fail "override probe path already exists: $override_root"
    finish
    return 1
  fi
  mkdir -p "$override_root"
  printf '\nMNDW_USER_PLUGINS_DIR="%s"\n' "$override_root" >> "$MNDW_CONFIG_FILE"

  if "$MNDW_MNDWD_INIT" stop >/dev/null 2>&1; then
    pass 'mndwd stopped before applying override'
  else
    note 'mndwd stop returned nonzero; continuing to test configure path'
  fi

  configure_log=$MNDW_CHECK_DIR/configure-override.log
  if opkg --force-reinstall install "$ipk_path" > "$configure_log" 2>&1; then
    pass "opkg reinstall completed with override: $ipk_path"
  else
    fail 'opkg configure failed with override'
    cat "$configure_log"
  fi

  MNDW_USER_PLUGINS_DIR=$override_root
  check_daemon_path "$override_root"

  if [ "$config_existed" -eq 1 ]; then
    cp -p "$config_backup" "$MNDW_CONFIG_FILE"
  else
    rm -f "$MNDW_CONFIG_FILE"
  fi

  if "$MNDW_MNDWD_INIT" stop >/dev/null 2>&1; then
    note 'mndwd stopped before restoring configuration'
  fi

  restore_log=$MNDW_CHECK_DIR/configure-restore.log
  if opkg --force-reinstall install "$ipk_path" > "$restore_log" 2>&1; then
    pass 'original configuration restored'
  else
    fail 'failed to restore original configuration'
    cat "$restore_log"
  fi

  rmdir "$override_root" 2>/dev/null || note "left non-empty override path: $override_root"
  finish
}

usage() {
  cat <<EOF
Usage:
  $0 preflight
  $0 upgrade [new.ipk]
  $0 remove-reinstall [new.ipk]
  $0 collision [newer.ipk]
  $0 override [ipk]
  $0 all [new.ipk]

Environment:
  MNDW_IPK_NEW       newer IPK used by upgrade/remove-reinstall
  MNDW_IPK_COLLISION newer IPK used by collision (defaults to MNDW_IPK_NEW)
  MNDW_DEVICE_HOST   device address for curl (default: 127.0.0.1)
  MNDW_ROOT          package root (default: /opt)

Run collision before a successful upgrade when using only two package versions,
or pass a third newer IPK after the normal upgrade. The check resolves its
disposable collision before returning so it does not leave opkg blocked.
EOF
}

if [ "${MNDW_VERIFY_NO_MAIN:-0}" -ne 1 ]; then
  case "${1:-help}" in
    preflight)
      mndw_preflight
      ;;
    upgrade)
      shift
      mndw_upgrade "${1:-}"
      ;;
    remove-reinstall)
      shift
      mndw_remove_reinstall "${1:-}"
      ;;
    collision)
      shift
      mndw_collision "${1:-}"
      ;;
    override)
      shift
      mndw_override "${1:-}"
      ;;
    all)
      shift
      all_status=0
      mndw_preflight || all_status=1
      mndw_upgrade "${1:-}" || all_status=1
      mndw_remove_reinstall "${1:-}" || all_status=1
      mndw_collision "${1:-}" || all_status=1
      mndw_override "${1:-}" || all_status=1
      exit "$all_status"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
fi
