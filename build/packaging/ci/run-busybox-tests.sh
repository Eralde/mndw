#!/bin/sh
# BusyBox sh-portability gate.
#
# Runs the daemon's sh-exec test suite under whatever /bin/sh the container
# provides (Alpine => BusyBox ash), so backend scripts are interpreted by the
# same shell family as the Keenetic router. The daemon execs plugin scripts
# directly via their `#!/bin/sh` shebang (internal/dispatch/dispatch.go,
# internal/lifecycle/lifecycle.go), so these tests genuinely exercise it.
#
# Scope is a SUBSET by design: only the packages relevant to the sh-exec
# path. Broaden each package list below ONLY when a new package grows a
# script-exec test. (internal/lifecycle has no test files today; it is here
# for compile coverage, its behavior covered via cmd/mndwd's integration
# suite.) The mws-page lifecyclehooks package is included for its direct
# stop-hook shell test. opkg stays stubbed (test default). No -race (musl/CGO).
set -eu

# Resolve the repo root from this script's own location so it works whether
# invoked as `build/packaging/ci/run-busybox-tests.sh` from the repo root or via
# `docker run -w /src sh build/packaging/ci/run-busybox-tests.sh`.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

cd "$repo_root/daemon/mndwd"

go mod download
go test ./cmd/mndwd/... ./internal/dispatch/... ./internal/lifecycle/...

cd "$repo_root/plugins/builtin/mws-page/backend"
go test ./internal/lifecyclehooks -run TestStopHookWaitsForProcess -count=1
