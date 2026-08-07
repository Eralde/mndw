#!/bin/sh
# Backend script for "__MNDW_NAME__", invoked for GET hello.
# The daemon serves this endpoint at /api/plugins/__MNDW_NAME__/hello.
# Emit an HTTP header block, a blank line, then the response body on stdout.

printf 'Content-Type: application/json\r\n\r\n'
printf '{"message":"hello from __MNDW_NAME__"}\n'
