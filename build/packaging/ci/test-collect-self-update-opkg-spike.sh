#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
collector="$script_dir/collect-self-update-opkg-spike.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-opkg-spike-test.XXXXXX")

cleanup() {
  rm -rf "$fixture_root"
}

trap cleanup EXIT HUP INT TERM

fake_bin="$fixture_root/bin"
state_dir="$fixture_root/state"
report="$fixture_root/report.txt"
mkdir -p "$fake_bin" "$state_dir"

cat > "$fake_bin/opkg" <<'EOF'
#!/bin/sh
set -eu

case "${1:-}" in
  --version)
    echo 'opkg version 0.6.0'
    ;;
  print-architecture)
    echo 'arch all 1'
    echo 'arch mipsel-3.4 10'
    ;;
  update)
    echo 'Updated package lists'
    ;;
  list-installed)
    if [ -f "$FAKE_VERSION_FILE" ]; then
      printf 'mndw - %s\n' "$(cat "$FAKE_VERSION_FILE")"
    else
      echo 'mndw - 0.0.3'
    fi
    ;;
  list-upgradable)
    echo 'mndw - 0.0.3 - 0.0.4'
    ;;
  download)
    : > "mndw_0.0.4_mipsel-3.4.ipk"
    ;;
  install)
    echo "install $*" >> "$FAKE_OPKG_LOG"
    printf '0.0.4\n' > "$FAKE_VERSION_FILE"
    ;;
  *)
    echo "unexpected opkg invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 755 "$fake_bin/opkg"

MNDW_STATE_DIR="$state_dir" \
MNDW_REPORT_PATH="$report" \
MNDW_CONFIRM_INSTALL=YES \
FAKE_OPKG_LOG="$fixture_root/opkg.log" \
FAKE_VERSION_FILE="$fixture_root/version" \
OPKG=opkg \
PATH="$fake_bin:$PATH" \
  sh "$collector"

grep -F 'RESULT: PASS' "$report"
grep -F 'mndw_0.0.4_mipsel-3.4.ipk' "$report"
grep -F 'mndw_0.0.4_mipsel-3.4.ipk' "$fixture_root/opkg.log"
[ ! -e "$report.firmware" ]
[ ! -e "$report.cwd" ]
[ ! -e "$report.download" ]

echo 'self-update opkg spike collector tests passed'
