#!/bin/sh
# Load lighttpd modules required by mndw, but only if not already loaded.

for mod in mod_proxy mod_rewrite mod_alias; do
  if ! grep -qs "\"$mod\"" /opt/etc/lighttpd/lighttpd.conf /opt/etc/lighttpd/conf.d/*.conf 2>/dev/null; then
    echo "server.modules += ( \"$mod\" )"
  fi
done
