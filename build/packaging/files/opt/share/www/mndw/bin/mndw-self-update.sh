#!/bin/sh
set -u

if [ "$#" -ne 4 ]; then
  exit 1
fi

OP=$1
CURRENT=$2
TARGET=$3
INSTALL_IPK=$4
STATE_DIR=${MNDW_STATE_DIR:-/opt/var/mndw}
CACHE_DIR=${MNDW_CACHE_DIR:-$STATE_DIR/opkg-cache}
MARKER=${MNDW_MARKER:-$STATE_DIR/self-update.json}
FAILURE=${MNDW_FAILURE:-$STATE_DIR/self-update.failure}
ROLLBACK_DIR=${MNDW_ROLLBACK_DIR:-$STATE_DIR/rollback}
COPY=${MNDW_COPY:-cp}
MOVE=${MNDW_MOVE:-mv}
CAPTURE_MKDIR=${MNDW_CAPTURE_MKDIR:-mkdir}
OPKG=${OPKG:-opkg}

fail() {
  code=$1

  if printf '%s\n' "$code" > "$FAILURE.tmp" 2>/dev/null; then
    if ! "$MOVE" "$FAILURE.tmp" "$FAILURE"; then
      rm -f "$FAILURE.tmp"
    fi
  else
    rm -f "$FAILURE.tmp"
  fi

  exit 1
}

valid_version() {
  case "$1" in
    ''|*[!A-Za-z0-9.+~:-]*) return 1 ;;
    *) return 0 ;;
  esac
}

valid_version "$CURRENT" || fail invalid-arguments
valid_version "$TARGET" || fail invalid-arguments

mkdir -p "$STATE_DIR" || fail invalid-arguments
if ! { : >&3; } 2>/dev/null; then
  fail invalid-arguments
fi

drop_rollback() {
  rm -f "$ROLLBACK_DIR/version" "$ROLLBACK_DIR/version.tmp" \
    "$ROLLBACK_DIR"/*.tmp "$ROLLBACK_DIR"/mndw-*.ipk 2>/dev/null || true
}

capture_rollback() {
  "$CAPTURE_MKDIR" -p "$CACHE_DIR" "$ROLLBACK_DIR" || return 1

  set -- "$CACHE_DIR"/mndw_"$CURRENT"_*.ipk
  [ "$#" -eq 1 ] || return 1
  [ -f "$1" ] && [ ! -L "$1" ] || return 1

  slot=$ROLLBACK_DIR/mndw-$CURRENT.ipk
  "$COPY" "$1" "$slot.tmp" || return 1
  "$MOVE" "$slot.tmp" "$slot" || return 1

  if [ -n "${MNDW_WRITE_VERSION:-}" ]; then
    "$MNDW_WRITE_VERSION" "$CURRENT" "$ROLLBACK_DIR/version.tmp" || return 1
  else
    printf '%s\n' "$CURRENT" > "$ROLLBACK_DIR/version.tmp" || return 1
  fi

  "$MOVE" "$ROLLBACK_DIR/version.tmp" "$ROLLBACK_DIR/version" || return 1

  for old in "$ROLLBACK_DIR"/mndw-*.ipk; do
    [ "$old" = "$slot" ] || rm -f "$old"
  done
}

case "$OP" in
  update)
    capture_rollback || drop_rollback

    [ -f "$INSTALL_IPK" ] && [ ! -L "$INSTALL_IPK" ] || fail update-missing

    if ! "$OPKG" install "$INSTALL_IPK" 3>&-; then
      rm -f "$INSTALL_IPK" 2>/dev/null || true
      fail opkg-install-failed
    fi

    rm -f "$INSTALL_IPK" 2>/dev/null || true
    ;;
  revert)
    [ -f "$INSTALL_IPK" ] && [ ! -L "$INSTALL_IPK" ] || fail rollback-missing

    if ! "$OPKG" install --force-reinstall --force-downgrade "$INSTALL_IPK" 3>&-; then
      fail opkg-revert-failed
    fi
    ;;
  *)
    fail invalid-arguments
    ;;
esac

rm -f "$MARKER" "$FAILURE" 2>/dev/null || true
exit 0
