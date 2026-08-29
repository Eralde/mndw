#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
install_script="$repo_root/build/packaging/install.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-install-policy.XXXXXX")
opkg_conf=/opt/etc/opkg/mndw-ownership-test.conf

cleanup() {
  rm -f "$opkg_conf"
  rm -rf "$fixture_root"
}

trap cleanup EXIT HUP INT TERM

fail() {
  echo "install policy test failed: $*" >&2
  exit 1
}

[ ! -e "$opkg_conf" ] || fail "refusing to overwrite existing test feed config: $opkg_conf"
mkdir -p /opt/etc/opkg || fail 'cannot create /opt/etc/opkg; run in disposable packaging container'

fake_bin="$fixture_root/bin"
policy_file="$fixture_root/var/lib/mndw/lighttpd-port-policy"
install_marker="$fixture_root/install-call"
mkdir -p "$fake_bin"

cat > "$fake_bin/opkg" <<'EOF'
#!/bin/sh
set -eu

case "${1:-}" in
  status)
    package=${2:-}
    case " $FAKE_INSTALLED_PACKAGES " in
      *" $package "*)
        printf 'Package: %s\n' "$package"
        printf 'Status: install ok installed\n'
        ;;
    esac
    ;;
  update)
    exit 0
    ;;
  install)
    [ -s "$MNDW_LIGHTTPD_POLICY_FILE" ] || {
      echo 'policy file was not written before opkg install' >&2
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

run_case() {
  expected=$1
  installed=$2
  seed=${3:-}

  rm -f "$policy_file" "$install_marker"
  if [ -n "$seed" ]; then
    mkdir -p "$(dirname "$policy_file")"
    printf '%s\n' "$seed" > "$policy_file"
  fi

  FAKE_INSTALLED_PACKAGES="$installed" \
    FAKE_INSTALL_MARKER="$install_marker" \
    MNDW_ROOT="$fixture_root" \
    MNDW_LIGHTTPD_POLICY_FILE="$policy_file" \
    PATH="$fake_bin:$PATH" \
    sh "$install_script" --feed-url http://feed.test --repo-name mndw-ownership-test

  [ -s "$policy_file" ] || fail "policy file missing for installed=[$installed] seed=[$seed]"
  actual=$(sed -n '1p' "$policy_file")
  [ "$actual" = "$expected" ] || fail "expected policy [$expected], got [$actual]"
  [ -s "$install_marker" ] || fail "fake opkg install was not called"
}

run_case preserve 'lighttpd'
run_case mndw ''
run_case mndw 'lighttpd mndw' mndw
run_case preserve 'mndw'
run_case mndw 'lighttpd' mndw

echo 'install policy tests passed'
