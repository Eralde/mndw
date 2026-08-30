#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)

sh -n "$repo_root/build/packaging/init/S70mndwd"
sh -n "$repo_root/build/packaging/ipk/postinst"
sh -n "$repo_root/build/packaging/ipk/postrm"
