#!/bin/sh
set -eu

REPO_NAME="mndw"
PACKAGE_NAME="mndw"
FEED_URL=""
MNDW_ROOT=${MNDW_ROOT:-/opt}
MNDW_LIGHTTPD_POLICY_FILE=${MNDW_LIGHTTPD_POLICY_FILE:-$MNDW_ROOT/var/lib/mndw/lighttpd-port-policy}

package_is_installed() {
  opkg status "$1" 2>/dev/null | awk '
    $1 == "Status:" && $2 == "install" && $3 == "ok" && $4 == "installed" { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

write_policy() {
  policy_value=$1
  policy_dir=$(dirname "$MNDW_LIGHTTPD_POLICY_FILE")
  temporary_policy="$MNDW_LIGHTTPD_POLICY_FILE.$$"

  case "$policy_value" in
    preserve|mndw) ;;
    *)
      echo "Error: invalid lighttpd ownership policy: $policy_value" >&2
      return 1
      ;;
  esac

  mkdir -p "$policy_dir" || return 1
  printf '%s\n' "$policy_value" > "$temporary_policy" || {
    rm -f "$temporary_policy"
    return 1
  }
  mv "$temporary_policy" "$MNDW_LIGHTTPD_POLICY_FILE" || {
    rm -f "$temporary_policy"
    return 1
  }
}

print_usage() {
  cat <<'EOF'
Usage:
  sh install.sh --feed-url <url> [options]

Required:
  --feed-url <url>         URL to OPKG feed directory containing Packages.gz

Options:
  --repo-name <name>       OPKG repo name (default: mndw)
  --package <name>         Package name to install (default: mndw)
  -h, --help               Show this help

Examples:
  sh install.sh --feed-url http://192.168.1.10:8080
  sh install.sh --feed-url https://example.com/mndw/repo --package mndw
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --feed-url)
      FEED_URL="${2:-}"
      shift 2
      ;;
    --repo-name)
      REPO_NAME="${2:-}"
      shift 2
      ;;
    --package)
      PACKAGE_NAME="${2:-}"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$FEED_URL" ]; then
  echo "Error: --feed-url is required" >&2
  print_usage >&2
  exit 1
fi

if ! command -v opkg >/dev/null 2>&1; then
  echo "Error: opkg is not installed on this device." >&2
  exit 1
fi

CONF_DIR="/opt/etc/opkg"
CONF_FILE="$CONF_DIR/${REPO_NAME}.conf"

mkdir -p "$CONF_DIR"
printf 'src/gz %s %s\n' "$REPO_NAME" "$FEED_URL" > "$CONF_FILE"

echo "[mndw] feed configured: $CONF_FILE"
echo "[mndw] running opkg update..."
opkg update

if package_is_installed "$PACKAGE_NAME"; then
  [ -e "$MNDW_LIGHTTPD_POLICY_FILE" ] || write_policy preserve
  policy_value=$(sed -n '1p' "$MNDW_LIGHTTPD_POLICY_FILE")
elif package_is_installed lighttpd; then
  [ -e "$MNDW_LIGHTTPD_POLICY_FILE" ] || write_policy preserve
  policy_value=$(sed -n '1p' "$MNDW_LIGHTTPD_POLICY_FILE")
else
  write_policy mndw
  policy_value=mndw
fi

echo "[mndw] lighttpd ownership policy: $policy_value"
echo "[mndw] installing package: $PACKAGE_NAME"
opkg install "$PACKAGE_NAME"

echo "[mndw] install complete."
