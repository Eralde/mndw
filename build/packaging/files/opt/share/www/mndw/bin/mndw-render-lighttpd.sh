#!/bin/sh
set -u

MNDW_PROXY_TARGET=${MNDW_PROXY_TARGET:-/opt/var/lib/mndw/proxy-target.conf}
MNDW_DOCROOT=${MNDW_DOCROOT:-/opt/share/www/mndw}
MNDW_USER_PLUGINS_DIR=${MNDW_USER_PLUGINS_DIR:-/opt/var/lib/mndw/user-plugins}

mode=
port=
output=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || exit 2
      mode=$2
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] || exit 2
      port=$2
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || exit 2
      output=$2
      shift 2
      ;;
    *)
      echo "mndw: unknown renderer argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$mode" in
  socket|override) ;;
  *)
    echo "mndw: renderer mode must be socket or override" >&2
    exit 2
    ;;
esac

case "$port" in
  ''|*[!0-9]*)
    echo "mndw: renderer port is invalid: $port" >&2
    exit 2
    ;;
esac

[ "$port" -ge 99 ] 2>/dev/null && [ "$port" -le 199 ] 2>/dev/null || {
  echo "mndw: renderer port is outside 99..199: $port" >&2
  exit 2
}

[ -n "$output" ] || {
  echo 'mndw: renderer output is required' >&2
  exit 2
}

output_dir=$(dirname "$output")
temporary_output="$output.$$"
mkdir -p "$output_dir" || exit 1

if [ "$mode" = 'socket' ]; then
  cat > "$temporary_output" <<EOF
\$SERVER["socket"] == ":$port" {
  server.document-root = "$MNDW_DOCROOT"
  index-file.names = ("index.html")
  alias.url += ( "/user-plugins/" => "$MNDW_USER_PLUGINS_DIR/" )

  \$HTTP["url"] =~ "^/(api|ws)/" {
    proxy.server = ( "" => (( "host" => "127.0.0.1", "port" => 9090 )) )
    proxy.header = ( "upgrade" => "enable" )
  }

  \$HTTP["url"] =~ "^/(rci|ci|auth)(/.*)?$" {
    include "$MNDW_PROXY_TARGET"
  }

  \$HTTP["url"] !~ "^/(auth|rci|ci|api|ws)(/|$)" {
    url.rewrite-if-not-file = ( "^/.*$" => "/index.html" )
  }
}
EOF
else
  cat > "$temporary_output" <<EOF
server.port = $port

\$SERVER["socket"] == ":$port" {
  server.document-root = "$MNDW_DOCROOT"
  index-file.names = ("index.html")
  alias.url += ( "/user-plugins/" => "$MNDW_USER_PLUGINS_DIR/" )

  \$HTTP["url"] =~ "^/(api|ws)/" {
    proxy.server = ( "" => (( "host" => "127.0.0.1", "port" => 9090 )) )
    proxy.header = ( "upgrade" => "enable" )
  }

  \$HTTP["url"] =~ "^/(rci|ci|auth)(/.*)?$" {
    include "$MNDW_PROXY_TARGET"
  }

  \$HTTP["url"] !~ "^/(auth|rci|ci|api|ws)(/|$)" {
    url.rewrite-if-not-file = ( "^/.*$" => "/index.html" )
  }
}
EOF
fi

status=$?

if [ "$status" -ne 0 ]; then
  rm -f "$temporary_output"
  exit "$status"
fi

mv "$temporary_output" "$output"
