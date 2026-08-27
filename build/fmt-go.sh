#!/usr/bin/env sh
set -eu

mode=$1
shift

if [ "${1:-}" = "--" ]; then
	shift
fi

if [ "$#" -eq 0 ]; then
	set -- daemon packages plugins
fi

exec env GOCACHE="$(pwd)/.cache/go-build" \
	go run ./tooling/go-blanklr "$mode" "$@"
