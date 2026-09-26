#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
default_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
repo_root=${MNDW_ROOT:-$default_root}

case "$repo_root" in
	/*) ;;
	*)
		printf 'MNDW_ROOT must be an absolute path: %s\n' "$repo_root" >&2
		exit 2
		;;
esac

if [ ! -d "$repo_root" ]; then
	printf 'repository root does not exist: %s\n' "$repo_root" >&2
	exit 2
fi
repo_root=$(CDPATH= cd -- "$repo_root" && pwd -P)

workspace_file="$repo_root/go.work"
if [ ! -f "$workspace_file" ]; then
	printf 'Go module inventory error: missing %s\n' "$workspace_file" >&2
	exit 2
fi

if ! command -v node >/dev/null 2>&1; then
	printf '%s\n' 'Go module inventory error: node is required to parse go.work' >&2
	exit 2
fi

if ! workspace_json=$(cd "$repo_root" && GOWORK="$workspace_file" go work edit -json); then
	printf 'Go module inventory error: cannot read %s\n' "$workspace_file" >&2
	exit 2
fi

if ! workspace_entries=$(printf '%s\n' "$workspace_json" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let document;
  try {
    document = JSON.parse(input);
  } catch (error) {
    process.stderr.write(`invalid go work JSON: ${error.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(document.Use) || document.Use.length === 0) {
    process.stderr.write("go.work must list at least one module\n");
    process.exit(1);
  }
  for (const entry of document.Use) {
    if (typeof entry.DiskPath !== "string" || entry.DiskPath.length === 0) {
      process.stderr.write("go.work contains a module without DiskPath\n");
      process.exit(1);
    }
    process.stdout.write(`${entry.DiskPath}\n`);
  }
});
'); then
	printf 'Go module inventory error: invalid or empty %s\n' "$workspace_file" >&2
	exit 2
fi

inventory_file=$(mktemp "${TMPDIR:-/tmp}/mndw-go-modules.XXXXXX")
workspace_paths_file=$(mktemp "${TMPDIR:-/tmp}/mndw-go-workspace.XXXXXX")
failures_file=$(mktemp "${TMPDIR:-/tmp}/mndw-go-failures.XXXXXX")
normalized_inventory="$inventory_file.normalized"
cleanup() {
	rm -f "$inventory_file" "$workspace_paths_file" "$failures_file" "$normalized_inventory"
}
trap cleanup EXIT HUP INT TERM
: > "$inventory_file"
: > "$workspace_paths_file"
: > "$failures_file"

while IFS= read -r disk_path; do
	case "$disk_path" in
		/*) module_dir=$disk_path ;;
		*) module_dir="$repo_root/$disk_path" ;;
	esac
	if [ ! -d "$module_dir" ] || [ ! -f "$module_dir/go.mod" ]; then
		printf 'Go module inventory error: go.work module is missing: %s\n' "$module_dir" >&2
		exit 2
	fi
	module_dir=$(CDPATH= cd -- "$module_dir" && pwd -P)
	printf '%s\n' "$module_dir" >> "$workspace_paths_file"
	printf '%s\n' "$module_dir" >> "$inventory_file"
done <<EOF
$workspace_entries
EOF

for scan_root in daemon packages tooling/go-blanklr plugins/builtin plugins/examples; do
	if [ ! -d "$repo_root/$scan_root" ]; then
		continue
	fi
	if ! find "$repo_root/$scan_root" \
		\( -name .nocommit -o -name .git -o -name node_modules -o -name .cache -o -name dist \) -prune \
		-o -type f -name go.mod -print >> "$inventory_file"; then
		printf 'Go module inventory error: failed scanning %s\n' "$repo_root/$scan_root" >&2
		exit 2
	fi
done

: > "$normalized_inventory"
while IFS= read -r module_path; do
	module_dir=${module_path%/go.mod}
	if [ ! -d "$module_dir" ] || [ ! -f "$module_dir/go.mod" ]; then
		printf 'Go module inventory error: discovered module is missing: %s\n' "$module_path" >&2
		exit 2
	fi
	canonical_dir=$(CDPATH= cd -- "$module_dir" && pwd -P)
	printf '%s\n' "$canonical_dir" >> "$normalized_inventory"
done < "$inventory_file"
mv "$normalized_inventory" "$inventory_file"
sort -u "$inventory_file" -o "$inventory_file"
sort -u "$workspace_paths_file" -o "$workspace_paths_file"

if [ ! -s "$inventory_file" ]; then
	printf 'Go module inventory error: no modules found under %s\n' "$repo_root" >&2
	exit 2
fi

cache_dir="$repo_root/.cache/go-build"
mkdir -p "$cache_dir"
failed_count=0
while IFS= read -r module_dir; do
	if grep -Fqx "$module_dir" "$workspace_paths_file"; then
		gowork="$workspace_file"
	else
		gowork=off
	fi
	printf 'Testing Go module: %s (GOWORK=%s)\n' "$module_dir" "$gowork"
	if (CDPATH= cd -- "$module_dir" && GOWORK="$gowork" GOCACHE="$cache_dir" go test ./...); then
		:
	else
		printf '%s\n' "$module_dir" >> "$failures_file"
		failed_count=$((failed_count + 1))
	fi
done < "$inventory_file"

if [ "$failed_count" -gt 0 ]; then
	printf 'Go module tests failed (%s):\n' "$failed_count" >&2
	while IFS= read -r failed_module; do
		printf '  %s\n' "$failed_module" >&2
	done < "$failures_file"
	exit 1
fi

printf 'Go module tests passed (%s modules).\n' "$(wc -l < "$inventory_file" | tr -d ' ')"
