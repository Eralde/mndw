#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
failed=0

for target in arm64 mips mipsle; do
	case "$target" in
		arm64)
			goarch=arm64
			gomips=
			;;
		mips)
			goarch=mips
			gomips=softfloat
			;;
		mipsle)
			goarch=mipsle
			gomips=softfloat
			;;
	esac

	for module_file in "$repo_root/daemon/mndwd/go.mod" "$repo_root"/plugins/*/*/backend/go.mod; do
		if [ ! -f "$module_file" ]; then
			continue
		fi

		module_dir=${module_file%/go.mod}
		module_name=${module_dir##*/}
		if [ "$module_name" = backend ]; then
			module_name=${module_dir%/backend}
			module_name=${module_name##*/}
		fi

		if (
			cd "$module_dir"
			export GOWORK=off
			export GOOS=linux
			export GOARCH="$goarch"
			if [ -n "$gomips" ]; then
				export GOMIPS="$gomips"
			else
				unset GOMIPS
			fi
			go vet ./...
		); then
			printf '%s %s: ok\n' "$module_name" "$target"
		else
			printf '%s %s: FAIL\n' "$module_name" "$target"
			failed=1
		fi
	done
done

exit "$failed"
