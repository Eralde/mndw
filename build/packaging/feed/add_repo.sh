#!/bin/sh
set -eu

FEED_KEY_ID=__FEED_KEY_ID__
UNRESOLVED_KEY_TOKEN='__FEED_'KEY_ID__
FEED_URL=${MNDW_FEED_URL:-https://eralde.github.io/mndw-opkg-feed}
OPKG=${OPKG:-opkg}
OPKG_CONF_DIR=${MNDW_OPKG_CONF_DIR:-/opt/etc/opkg}
OPKG_CACHE_DIR=${MNDW_OPKG_CACHE_DIR:-/opt/var/mndw/opkg-cache}
KEY_DIR=${MNDW_KEY_DIR:-$OPKG_CONF_DIR/keys}
CONF_FILE=$OPKG_CONF_DIR/mndw-feed.conf
ARCH_FILE=${TMPDIR:-/tmp}/mndw-feed-architecture.$$

fail() {
  echo "[mndw] $*" >&2
  exit 1
}

cleanup() {
  rm -f "$ARCH_FILE" "$CONF_FILE.tmp.$$" "$KEY_DIR/$FEED_KEY_ID.pub.tmp.$$"
}

trap cleanup EXIT HUP INT TERM

case "$FEED_KEY_ID" in
  ''|*[!A-Za-z0-9._+-]*)
    fail "feed key id is missing or unsafe"
    ;;
esac

[ "$FEED_KEY_ID" != "$UNRESOLVED_KEY_TOKEN" ] || fail "feed key id is unresolved: $FEED_KEY_ID"

FEED_URL=${FEED_URL%/}

if [ -z "${MNDW_FETCH:-}" ]; then
  if ! command -v wget >/dev/null 2>&1; then
    fail "wget without HTTPS: run opkg install wget-ssl ca-bundle"
  fi

  WGET_VERSION=$(wget --version 2>&1) || WGET_VERSION=
  case "$WGET_VERSION" in
    *+ssl*) ;;
    *) fail "wget without HTTPS: run opkg install wget-ssl ca-bundle" ;;
  esac
fi

"$OPKG" print-architecture > "$ARCH_FILE" || fail "opkg print-architecture failed"
FEED_ARCH=$(awk '$1 == "arch" && ($2 == "aarch64-3.10" || $2 == "mips-3.4" || $2 == "mipsel-3.4") {print $2}' "$ARCH_FILE" | sed -n '1p')

[ -n "$FEED_ARCH" ] || fail "device has no supported architecture"

mkdir -p "$KEY_DIR"
KEY_FILE=$KEY_DIR/$FEED_KEY_ID.pub

if [ ! -f "$KEY_FILE" ]; then
  KEY_TMP=$KEY_FILE.tmp.$$

  if [ -n "${MNDW_FETCH:-}" ]; then
    "$MNDW_FETCH" "$FEED_URL/$FEED_KEY_ID.pub" > "$KEY_TMP" || fail "public key download failed"
  else
    wget -qO- "$FEED_URL/$FEED_KEY_ID.pub" > "$KEY_TMP" || fail "public key download failed"
  fi

  [ -s "$KEY_TMP" ] || fail "public key download was empty"
  mv "$KEY_TMP" "$KEY_FILE"
fi

if [ ! -e "$CONF_FILE" ]; then
  mkdir -p "$OPKG_CONF_DIR" "$OPKG_CACHE_DIR"
  {
    echo "src/gz mndw $FEED_URL/$FEED_ARCH"
    echo "option cache $OPKG_CACHE_DIR"
  } > "$CONF_FILE.tmp.$$"
  mv "$CONF_FILE.tmp.$$" "$CONF_FILE"
fi

echo "[mndw] feed configured for $FEED_ARCH"
echo "[mndw] running opkg update..."
"$OPKG" update

echo "[mndw] installing package: mndw"
"$OPKG" install mndw

echo "[mndw] feed bootstrap complete."
