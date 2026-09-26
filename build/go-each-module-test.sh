#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/mndw-go-each-module.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

fixture_root="$test_root/repo"
fake_bin="$test_root/bin"
log_file="$test_root/go.log"
work_log="$test_root/work.log"
mkdir -p "$fixture_root" "$fake_bin"
fixture_root=$(CDPATH= cd -- "$fixture_root" && pwd -P)

cat > "$fake_bin/go" <<'FAKE_GO'
#!/bin/sh
set -eu

if [ "${1:-}" = work ] && [ "${2:-}" = edit ] && [ "${3:-}" = -json ]; then
	printf '%s\n' "${GOWORK:-}" >> "$FAKE_WORK_LOG"
	if [ "${FAKE_WORK_JSON+x}" = x ]; then
		printf '%s\n' "$FAKE_WORK_JSON"
	else
		printf '{"Use":[]}\n'
	fi
	exit 0
fi

printf '%s|%s|%s\n' "$PWD" "${GOWORK:-}" "${GOCACHE:-}" >> "$FAKE_GO_LOG"

if [ -f fail-tests ]; then
	exit 1
fi
FAKE_GO
chmod +x "$fake_bin/go"

module_dirs='daemon/mndwd
packages/standalone
plugins/builtin/demo/backend
tooling/cli/templates/go/backend
workspace-extra'
printf '%s\n' "$module_dirs" | while IFS= read -r module_dir; do
	mkdir -p "$fixture_root/$module_dir"
	: > "$fixture_root/$module_dir/go.mod"
done

touch "$fixture_root/go.work"
work_json='{"Use":[{"DiskPath":"./daemon/mndwd"},{"DiskPath":"./workspace-extra"}]}'

FAKE_GO_LOG="$log_file" \
FAKE_WORK_LOG="$work_log" \
FAKE_WORK_JSON="$work_json" \
PATH="$fake_bin:$PATH" \
MNDW_ROOT="$fixture_root" \
	GOWORK="$test_root/decoy.work" \
	sh "$repo_root/build/go-each-module.sh"

cat > "$test_root/expected.log" <<EOF
$fixture_root/daemon/mndwd|$fixture_root/go.work|$fixture_root/.cache/go-build
$fixture_root/packages/standalone|off|$fixture_root/.cache/go-build
$fixture_root/plugins/builtin/demo/backend|off|$fixture_root/.cache/go-build
$fixture_root/workspace-extra|$fixture_root/go.work|$fixture_root/.cache/go-build
EOF

if ! cmp -s "$test_root/expected.log" "$log_file"; then
	cat "$log_file" >&2
	printf '%s\n' 'module execution order or environment differs from expected' >&2
	exit 1
fi

printf '%s\n' "$fixture_root/go.work" > "$test_root/expected-work.log"
if ! cmp -s "$test_root/expected-work.log" "$work_log"; then
	cat "$work_log" >&2
	printf '%s\n' 'runner did not use MNDW_ROOT/go.work for inventory' >&2
	exit 1
fi

touch "$fixture_root/packages/standalone/fail-tests"
touch "$fixture_root/workspace-extra/fail-tests"
: > "$log_file"
if ! FAKE_GO_LOG="$log_file" FAKE_WORK_LOG="$work_log" FAKE_WORK_JSON="$work_json" PATH="$fake_bin:$PATH" MNDW_ROOT="$fixture_root" \
	sh "$repo_root/build/go-each-module.sh" >"$test_root/output.log" 2>&1; then
	:
else
	printf '%s\n' 'runner succeeded despite a failing module' >&2
	exit 1
fi

if ! rg -F "$fixture_root/packages/standalone" "$test_root/output.log" >/dev/null || \
	! rg -F "$fixture_root/workspace-extra" "$test_root/output.log" >/dev/null || \
	! rg -F 'Go module tests failed (2)' "$test_root/output.log" >/dev/null; then
	cat "$test_root/output.log" >&2
	printf '%s\n' 'runner did not report the standalone module failure' >&2
	exit 1
fi

missing_root="$test_root/missing-module"
mkdir -p "$missing_root"
: > "$missing_root/go.work"
missing_json='{"Use":[{"DiskPath":"./not-present"}]}'
if FAKE_GO_LOG="$log_file" FAKE_WORK_LOG="$work_log" FAKE_WORK_JSON="$missing_json" PATH="$fake_bin:$PATH" MNDW_ROOT="$missing_root" \
	sh "$repo_root/build/go-each-module.sh" >"$test_root/missing.log" 2>&1; then
	printf '%s\n' 'runner accepted a missing workspace module' >&2
	exit 1
fi

empty_root="$test_root/empty-workspace"
mkdir -p "$empty_root/packages/standalone"
: > "$empty_root/packages/standalone/go.mod"
: > "$empty_root/go.work"
if FAKE_GO_LOG="$log_file" FAKE_WORK_LOG="$work_log" FAKE_WORK_JSON='{"Use":[]}' PATH="$fake_bin:$PATH" MNDW_ROOT="$empty_root" \
	sh "$repo_root/build/go-each-module.sh" >"$test_root/empty.log" 2>&1; then
	printf '%s\n' 'runner accepted an empty workspace' >&2
	exit 1
fi

missing_work_root="$test_root/missing-workspace"
mkdir -p "$missing_work_root/packages/standalone"
: > "$missing_work_root/packages/standalone/go.mod"
if FAKE_GO_LOG="$log_file" PATH="$fake_bin:$PATH" MNDW_ROOT="$missing_work_root" \
	sh "$repo_root/build/go-each-module.sh" >"$test_root/missing-work.log" 2>&1; then
	printf '%s\n' 'runner accepted a missing go.work' >&2
	exit 1
fi

printf '%s\n' 'go-each-module runner tests passed'
