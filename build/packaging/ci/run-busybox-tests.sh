#!/bin/sh
# BusyBox sh-portability gate.
#
# Runs the daemon's sh-exec test suite under whatever /bin/sh the container
# provides (Alpine => BusyBox ash), so backend commands are interpreted by the
# same shell family as the Keenetic router. The daemon executes exec
# commands directly via their `#!/bin/sh` shebang, so backend tests genuinely
# exercise it.
#
# Scope is a SUBSET by design: daemon wiring, backend command validation/exec,
# and foreground built-in services. opkg is not exercised by this subset; tests
# that need it inject a stub explicitly.
# No -race (musl/CGO).
set -eu

# Resolve the repo root from this script's own location so it works whether
# invoked as `build/packaging/ci/run-busybox-tests.sh` from the repo root or via
# `docker run -w /src sh build/packaging/ci/run-busybox-tests.sh`.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)

cd "$repo_root/daemon/mndwd"

export GOCACHE="$repo_root/.cache/go-build"
go test ./cmd/mndwd/... ./internal/backend/... ./internal/httpx/...

cd "$repo_root/plugins/examples/ping-widget/backend"
go test ./...

cd "$repo_root/plugins/builtin/mws-page/backend"
go test ./... -run '^$'

cd "$repo_root/plugins/builtin/terminal-page/backend"
GOWORK=off go test ./...
