#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
install_script="$repo_root/build/packaging/install.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-install-test.XXXXXX")
opkg_conf="$fixture_root/opkg/mndw-front-door-test.conf"

cleanup() {
  rm -f "$opkg_conf"
  rm -rf "$fixture_root"
}

trap cleanup EXIT HUP INT TERM

fail() {
  echo "install test failed: $*" >&2
  exit 1
}

[ ! -e "$opkg_conf" ] || fail "refusing to overwrite existing test feed config: $opkg_conf"

fake_bin="$fixture_root/bin"
install_marker="$fixture_root/install-call"
mkdir -p "$fake_bin"

cat > "$fake_bin/opkg" <<'EOF'
#!/bin/sh
set -eu

case "${1:-}" in
  update)
    printf '%s\n' update >> "$FAKE_OPKG_LOG"
    ;;
  install)
    [ ! -e "$MNDW_ROOT/var/lib/mndw/lighttpd-port-policy" ] || {
      echo 'install.sh unexpectedly wrote retired lighttpd policy' >&2
      exit 1
    }
    printf '%s\n' "$*" > "$FAKE_INSTALL_MARKER"
    ;;
  *)
    echo "unexpected opkg invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 755 "$fake_bin/opkg"

FAKE_INSTALL_MARKER="$install_marker" \
FAKE_OPKG_LOG="$fixture_root/opkg-log" \
MNDW_ROOT="$fixture_root" \
MNDW_OPKG_CONF_DIR="$(dirname "$opkg_conf")" \
PATH="$fake_bin:$PATH" \
  sh "$install_script" --feed-url http://feed.test --repo-name mndw-front-door-test

[ -s "$install_marker" ] || fail 'fake opkg install was not called'
[ "$(sed -n '1p' "$fixture_root/opkg-log")" = update ] || fail 'opkg update was not called'
[ ! -e "$fixture_root/var/lib/mndw/lighttpd-port-policy" ] || fail 'retired policy file was created'

echo 'install tests passed'
