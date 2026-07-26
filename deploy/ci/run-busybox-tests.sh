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
# path. Broaden the `go test` list below ONLY if a new package grows a
# script-exec test. (internal/lifecycle has no test files today; it is here
# for compile coverage, its behavior covered via cmd/mndwd's integration
# suite.) opkg stays stubbed (test default). No -race (musl/CGO).
set -eu

# Resolve the repo root from this script's own location so it works whether
# invoked as `deploy/ci/run-busybox-tests.sh` from the repo root or via
# `docker run -w /src sh deploy/ci/run-busybox-tests.sh`.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

cd "$repo_root/packages/daemon"

go mod download
go test ./cmd/mndwd/... ./internal/dispatch/... ./internal/lifecycle/...
