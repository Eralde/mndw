#!/bin/sh
set -eu

fixture_dir=${IPERF_FIXTURE_DIR:?}
port=""
reverse=0

while [ "$#" -gt 0 ]; do
	case "$1" in
		-p)
			port=$2
			shift 2
			;;
		-R)
			reverse=1
			shift
			;;
		*)
			shift
			;;
	esac
done

if [ "${IPERF_SLEEP_FIRST:-0}" = "1" ]; then
	calls=0
	if [ -n "${IPERF_CALLS_FILE:-}" ] && [ -f "$IPERF_CALLS_FILE" ]; then
		calls=$(cat "$IPERF_CALLS_FILE")
	fi
	calls=$((calls + 1))
	if [ -n "${IPERF_CALLS_FILE:-}" ]; then
		printf '%s\n' "$calls" > "$IPERF_CALLS_FILE"
	fi
	if [ "$calls" -eq 1 ]; then
		if [ -n "${IPERF_PID_FILE:-}" ]; then
			printf '%s\n' "$$" > "$IPERF_PID_FILE"
		fi
		printf '%s\n' '{"event":"interval","data":{"sum":{"bits_per_second":123,"end":1}}}'
		exec sleep 30
	fi
fi

if [ "${IPERF_BUSY_ALL:-0}" = "1" ] || [ "${IPERF_BUSY_PORT:-}" = "$port" ]; then
	exec cat "$fixture_dir/busy.jsonl"
fi

if [ "$reverse" -eq 1 ]; then
	exec cat "$fixture_dir/download.jsonl"
fi

exec cat "$fixture_dir/upload.jsonl"
