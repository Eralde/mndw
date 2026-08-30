package opkg

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newExecManagerWithRunner(t *testing.T, runner func(context.Context, ...string) (string, int, error)) *execManager {
	t.Helper()

	stateDir := t.TempDir()

	return &execManager{
		logger:     discard(),
		runner:     runner,
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
}

func TestStubInstallListRemove(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()

	if err := m.Install(ctx, []string{"curl", "ttyd"}); err != nil {
		t.Fatalf("install: %v", err)
	}

	installed, err := m.ListInstalled(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(installed, []string{"bash", "curl", "jq", "ttyd"}) {
		t.Errorf("installed = %v, want [bash curl jq ttyd]", installed)
	}

	if err := m.Remove(ctx, []string{"curl"}); err != nil {
		t.Fatalf("remove: %v", err)
	}

	installed, _ = m.ListInstalled(ctx)

	if !slices.Equal(installed, []string{"bash", "jq", "ttyd"}) {
		t.Errorf("after remove = %v, want [bash jq ttyd]", installed)
	}
}

func TestStubListAvailableIncludesInstalled(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()

	if err := m.Install(ctx, []string{"myextra"}); err != nil {
		t.Fatal(err)
	}

	avail, _ := m.ListAvailable(ctx)

	if !slices.Contains(avail, "myextra") {
		t.Errorf("available should include installed myextra, got %v", avail)
	}

	if !slices.Contains(avail, "curl") {
		t.Errorf("available should include catalog curl, got %v", avail)
	}

	if !slices.Contains(avail, "bash") || !slices.Contains(avail, "jq") {
		t.Errorf("available should include pre-installed bash and jq, got %v", avail)
	}
}

func TestValidateRejectsBadNames(t *testing.T) {
	m := New("stub", discard())
	err := m.Install(context.Background(), []string{"ok", "BAD NAME"})
	var invalid *InvalidPackageError

	if !errors.As(err, &invalid) {
		t.Fatalf("expected InvalidPackageError, got %v", err)
	}

	if invalid.Name != "BAD NAME" {
		t.Errorf("invalid name = %q", invalid.Name)
	}
}

func TestValidateRejectsEmpty(t *testing.T) {
	m := New("stub", discard())

	if err := m.Install(context.Background(), nil); err == nil {
		t.Fatal("expected error for empty package list")
	}
}

func TestParseNames(t *testing.T) {
	out := "curl - 8.0.1-1 - a tool\nttyd - 1.7.4 - terminal\n\n"
	got := parseNames(out)

	if !slices.Equal(got, []string{"curl", "ttyd"}) {
		t.Errorf("parseNames = %v, want [curl ttyd]", got)
	}
}

func TestParseNamesIgnoresArchitectureWarnings(t *testing.T) {
	out := "Package mndw version 0.0.1 has no valid architecture, ignoring.\n" +
		"curl - 8.0.1-1 - a tool\n"

	got := parseNames(out)

	if !slices.Equal(got, []string{"curl"}) {
		t.Errorf("parseNames = %v, want [curl]", got)
	}
}

func TestParseEntries(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		wantLen int
		wantErr bool
	}{
		{name: "valid with description", output: "curl - 8.0.1-1 - Client URL retrieval utility\r\n", wantLen: 1},
		{name: "valid without description", output: "antiscan2 - 2-alpha18\n", wantLen: 1},
		{name: "separator in description", output: "pkg - 1.0-1 - desc - with separator\n", wantLen: 1},
		{name: "empty description", output: "pkg - 1.0-1 - \n", wantLen: 1},
		{name: "missing version separator", output: "pkg 1.0-1\n", wantErr: true},
		{name: "empty name", output: " - 1.0-1 - desc\n", wantErr: true},
		{name: "empty version", output: "pkg -  - desc\n", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseEntries(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseEntries() error = %v, wantErr %v", err, tt.wantErr)
			}

			if err == nil && len(got) != tt.wantLen {
				t.Fatalf("len(parseEntries()) = %d, want %d", len(got), tt.wantLen)
			}
		})
	}
}

func TestParseUpgradableCandidate(t *testing.T) {
	got, ok, err := parseUpgradable("curl - 1 - 2\nmndw - 0.0.3 - 0.0.4\n", "mndw")
	if err != nil || !ok || got.CurrentVersion != "0.0.3" || got.TargetVersion != "0.0.4" {
		t.Fatalf("candidate=%+v ok=%v err=%v", got, ok, err)
	}
}

func TestParseUpgradableRejectsDuplicateMndwRows(t *testing.T) {
	_, _, err := parseUpgradable("mndw - 0.0.3 - 0.0.4\nmndw - 0.0.3 - 0.0.5\n", "mndw")
	if err == nil {
		t.Fatal("duplicate mndw candidate unexpectedly accepted")
	}
}

func TestLeaseHandoffKeepsFlockUntilChildCopyCloses(t *testing.T) {
	stateDir := t.TempDir()
	lockPath := filepath.Join(stateDir, "opkg.lock")
	m := &execManager{
		logger:     discard(),
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   lockPath,
	}

	lease, err := m.acquireMutation(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	childFD, err := unix.Dup(int(lease.File().Fd()))
	if err != nil {
		t.Fatal(err)
	}

	if err := lease.CommitHandoff(); err != nil {
		t.Fatal(err)
	}

	if _, err := m.acquireMutation(context.Background(), false); !errors.Is(err, ErrBusy) {
		t.Fatalf("want ErrBusy, got %v", err)
	}

	if err := unix.Close(childFD); err != nil {
		t.Fatal(err)
	}

	released, err := m.acquireMutation(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if err := released.Abort(); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareSelfUpdateDownloadsNormalizedCandidate(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		StateDir:   filepath.Join(root, "state"),
		PendingDir: filepath.Join(root, "pending"),
		LockPath:   filepath.Join(root, "state", "opkg.lock"),
	}

	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg update":
			return "", 0, nil
		case "opkg list-installed mndw":
			return "mndw - 0.0.3\n", 0, nil
		case "opkg list-upgradable":
			return "mndw - 0.0.3 - 0.0.4\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}

	downloadRunner := func(_ context.Context, dir string, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg download mndw" {
			t.Fatalf("download args = %v", args)
		}

		if err := os.WriteFile(filepath.Join(dir, "mndw_0.0.4_mipsel-3.4.ipk"), []byte("ipk"), 0o644); err != nil {
			t.Fatal(err)
		}

		return "", 0, nil
	}

	m := &execManager{
		logger:         discard(),
		runner:         runner,
		downloadRunner: downloadRunner,
		gate:           make(chan struct{}, 1),
		stateDir:       paths.StateDir,
		pendingDir:     paths.PendingDir,
		lockPath:       paths.LockPath,
	}

	candidate, lease, err := m.PrepareSelfUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer lease.Abort()

	if candidate.CurrentVersion != "0.0.3" || candidate.TargetVersion != "0.0.4" {
		t.Fatalf("candidate = %+v", candidate)
	}

	if candidate.PackagePath != filepath.Join(paths.PendingDir, "mndw-0.0.4.ipk") {
		t.Fatalf("package path = %q", candidate.PackagePath)
	}

	if _, err := os.Stat(candidate.PackagePath); err != nil {
		t.Fatalf("normalized IPK: %v", err)
	}
}

func TestParseInfoBlocksSelectsInstalledExactBlock(t *testing.T) {
	out := "Package: curl\nVersion: 8.0.1-1\nDescription: Feed description\nSize: 100\nDepends: libc, libcurl | libssl\n\n" +
		"Package: curl\nVersion: 7.55.1-1\nDescription: Installed description\nSize: 90\nDepends: libc, libcurl | libssl\n"
	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	got, err := selectInfoBlock(blocks, "curl", "7.55.1-1")
	if err != nil {
		t.Fatal(err)
	}

	if got.Version != "7.55.1-1" || got.Description != "Installed description" {
		t.Fatalf("selected block = %+v", got)
	}

	if !slices.Equal(got.Dependencies, []string{"libc", "libcurl | libssl"}) {
		t.Fatalf("dependencies = %v", got.Dependencies)
	}
}

func TestParseInfoBlocksFallsBackToFirstFeedBlock(t *testing.T) {
	out := "Package: curl\nVersion: 8.0.1-1\nDescription: First\n\nPackage: curl\nVersion: 9.0.0-1\nDescription: Second\n"
	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	got, err := selectInfoBlock(blocks, "curl", "")
	if err != nil {
		t.Fatal(err)
	}

	if got.Version != "8.0.1-1" {
		t.Fatalf("selected version = %q", got.Version)
	}
}

func TestParseInfoBlocksAcceptsDescriptionContinuationLines(t *testing.T) {
	out := "Package: antiscan2\nVersion: 2-alpha26\nDescription: Anti-scan utility\n /opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601\nSize: 123\n"

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}

	if blocks[0].Description != "Anti-scan utility\n/opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601" {
		t.Fatalf("description = %q", blocks[0].Description)
	}
}

func TestParseInfoBlocksAcceptsConffilesListLines(t *testing.T) {
	out := "Package: antiscan2\n" +
		"Version: 2.0-alpha26\n" +
		"Status: install ok installed\n" +
		"Architecture: aarch64-3.10\n" +
		"Size: 74141\n" +
		"Conffiles:\n" +
		" /opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601\n" +
		" /opt/etc/antiscan/ascn_crontab.conf 2ea489b2c8a2cafbb982101a0defb40afe15cb6b47b0e526ea81037f26bc9706\n" +
		"Description: Antiscan2 utility\n" +
		"Installed-Time: 1787315636\n"

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}

	if blocks[0].Description != "Antiscan2 utility" {
		t.Fatalf("description = %q", blocks[0].Description)
	}

	if blocks[0].InstalledTime != "1787315636" {
		t.Fatalf("installed time = %q", blocks[0].InstalledTime)
	}
}

func TestParseInfoBlocksAcceptsUnindentedDescriptionContinuationLines(t *testing.T) {
	out := "Package: antiscan2\nVersion: 2-alpha26\nDescription: Anti-scan utility\n/opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601\nSize: 123\n"

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}

	if blocks[0].Description == "" {
		t.Fatal("description is empty")
	}
}

func TestExecInfoDerivesUpdateAvailableWithStringInequality(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg info curl":
			return "Package: curl\nVersion: 10-1\nDescription: Feed\nSize: 10\n", 0, nil
		case "opkg status curl":
			return "Package: curl\nVersion: 9-1\nStatus: install user installed\nInstalled-Size: 20\nInstalled-Time: 123\n", 0, nil
		case "opkg list-installed":
			return "curl - 9-1 - Installed\n", 0, nil
		case "opkg list":
			return "curl - 10-1 - Feed\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}
	m := newExecManagerWithRunner(t, runner)
	info, err := m.Info(context.Background(), "curl")
	if err != nil {
		t.Fatal(err)
	}

	if info.Status != "update_available" || info.Version != "10-1" || info.InstalledSize != "20" || info.InstalledTime != "123" {
		t.Fatalf("info = %+v", info)
	}
}

func TestProtectedPackageRejectedBeforeRunner(t *testing.T) {
	calls := 0
	m := newExecManagerWithRunner(t, func(context.Context, ...string) (string, int, error) {
		calls++

		return "", 0, nil
	})
	err := m.Remove(context.Background(), []string{"mndw"})
	var protected *ProtectedPackageError

	if !errors.As(err, &protected) || calls != 0 {
		t.Fatalf("error = %v, calls = %d", err, calls)
	}
}

func TestDetectDependents(t *testing.T) {
	tests := []struct {
		name       string
		out        string
		wantPkg    string
		wantDepend []string
		wantNil    bool
	}{
		{
			name:    "no warning",
			out:     "Removing package curl from root...\n",
			wantNil: true,
		},
		{
			name:       "plain warning",
			out:        "Package curl is depended upon by packages:\n\twget-ssl\n\tThese might cease to work if package curl is removed.\n",
			wantPkg:    "curl",
			wantDepend: []string{"wget-ssl"},
		},
		{
			// The device's opkg prefixes EVERY line — dependent names and the advisory
			// lines included — with the " * <function>: " collected-error decoration.
			name: "collected-errors label on every line",
			out: "Collected errors:\n" +
				" * print_dependents_warning: Package curl is depended upon by packages:\n" +
				" * print_dependents_warning: \twget-ssl\n" +
				" * print_dependents_warning: \taria2\n" +
				" * print_dependents_warning: These might cease to work if package curl is removed.\n" +
				" * print_dependents_warning: Force removal of this package via --force-depends\n" +
				" * print_dependents_warning: Force removal of this and dependent packages via --force-removal-of-dependent-packages\n",
			wantPkg:    "curl",
			wantDepend: []string{"wget-ssl", "aria2"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectDependents(tt.out)

			if tt.wantNil {
				if got != nil {
					t.Fatalf("detectDependents = %v, want nil", got)
				}

				return
			}

			if got == nil {
				t.Fatal("detectDependents = nil, want conflict")
			}

			if got.Package != tt.wantPkg {
				t.Errorf("package = %q, want %q", got.Package, tt.wantPkg)
			}

			if !slices.Equal(got.DependedBy, tt.wantDepend) {
				t.Errorf("dependedBy = %v, want %v", got.DependedBy, tt.wantDepend)
			}
		})
	}
}

// TestExecRemoveDetectsDependencyConflictOnZeroExit pins the fix: opkg refuses a
// removal with a reverse-dependency warning while exiting 0, and Remove must surface
// that as a DependencyConflictError instead of reporting success.
func TestExecRemoveDetectsDependencyConflictOnZeroExit(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg remove curl" {
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}

		return "Package curl is depended upon by packages:\n\twget-ssl\n\tThese might cease to work if package curl is removed.\n", 0, nil
	}
	m := newExecManagerWithRunner(t, runner)
	err := m.Remove(context.Background(), []string{"curl"})
	var conflict *DependencyConflictError

	if !errors.As(err, &conflict) {
		t.Fatalf("Remove error = %v, want *DependencyConflictError", err)
	}

	if conflict.Package != "curl" || !slices.Equal(conflict.DependedBy, []string{"wget-ssl"}) {
		t.Fatalf("conflict = %+v", conflict)
	}
}

// TestExecRemoveDetectsDependencyConflictOnNonZeroExit covers the device's opkg,
// which exits non-zero and prints the reverse-dependency warning (via its "Collected
// errors" section) to stderr. Remove must surface the typed conflict rather than the
// generic "opkg remove exited N" error.
func TestExecRemoveDetectsDependencyConflictOnNonZeroExit(t *testing.T) {
	out := "Collected errors:\n" +
		" * print_dependents_warning: Package curl is depended upon by packages:\n" +
		" * print_dependents_warning: \twget-ssl\n" +
		" * print_dependents_warning: \taria2\n" +
		" * print_dependents_warning: These might cease to work if package curl is removed.\n" +
		" * print_dependents_warning: Force removal of this package via --force-depends\n"
	runner := func(_ context.Context, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg remove curl" {
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}

		return out, 255, nil
	}
	m := newExecManagerWithRunner(t, runner)
	err := m.Remove(context.Background(), []string{"curl"})
	var conflict *DependencyConflictError

	if !errors.As(err, &conflict) {
		t.Fatalf("Remove error = %v, want *DependencyConflictError", err)
	}

	if conflict.Package != "curl" || !slices.Equal(conflict.DependedBy, []string{"wget-ssl", "aria2"}) {
		t.Fatalf("conflict = %+v", conflict)
	}
}

func TestExecRemoveSucceedsWithoutDependents(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg remove curl" {
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}

		return "Removing package curl from root...\n", 0, nil
	}

	if err := newExecManagerWithRunner(t, runner).Remove(context.Background(), []string{"curl"}); err != nil {
		t.Fatalf("Remove = %v, want nil", err)
	}
}

func TestMetadataUpdatedAtUsesNewestEntryMtime(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "old")
	newPath := filepath.Join(dir, "new")

	if err := os.WriteFile(oldPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(newPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	old := time.Unix(100, 0)
	newer := time.Unix(200, 0)

	if err := os.Chtimes(oldPath, old, old); err != nil {
		t.Fatal(err)
	}

	if err := os.Chtimes(newPath, newer, newer); err != nil {
		t.Fatal(err)
	}

	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg list-installed", "opkg list":
			return "", 0, nil
		default:
			return "", 0, errors.New("unexpected command")
		}
	}
	m := newExecManagerWithRunner(t, runner)
	m.listsDir = dir
	result, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if result.MetadataUpdatedAt == nil || !result.MetadataUpdatedAt.Equal(newer.UTC()) {
		t.Fatalf("metadataUpdatedAt = %v, want %v", result.MetadataUpdatedAt, newer.UTC())
	}
}

func TestExecListMergeAndOrphan(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg list-installed":
			return "curl - 7.55.1-1 - Installed desc\norphan - 2.1.0-1 - Custom tool\n", 0, nil
		case "opkg list":
			return "curl - 8.0.1-1 - Feed desc\nsocat - 1.7.4.4-1 - Relay\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}

	result, err := newExecManagerWithRunner(t, runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages

	if len(entries) != 3 {
		t.Fatalf("len(entries) = %d, want 3", len(entries))
	}

	if entries[0].Name != "curl" || entries[0].Version != "7.55.1-1" || entries[0].Description != "Feed desc" || entries[0].Status != "update_available" || entries[0].NewVersion != "8.0.1-1" {
		t.Errorf("curl entry = %+v", entries[0])
	}

	if entries[1].Name != "orphan" || entries[1].Version != "2.1.0-1" || entries[1].Description != "Custom tool" || entries[1].Status != "installed" || entries[1].NewVersion != "" {
		t.Errorf("orphan entry = %+v", entries[1])
	}

	if entries[2].Name != "socat" || entries[2].Status != "available" {
		t.Errorf("socat entry = %+v", entries[2])
	}
}

func TestExecListIgnoresArchitectureWarnings(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg list-installed":
			return "curl - 7.55.1-1 - Installed desc\n", 0, nil
		case "opkg list":
			return "Package mndw version 0.0.1 has no valid architecture, ignoring.\n" +
				"curl - 8.0.1-1 - Feed desc\n" +
				"socat - 1.7.4.4-1 - Relay\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}

	result, err := newExecManagerWithRunner(t, runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages

	if len(entries) != 2 {
		t.Fatalf("len(entries) = %d, want 2", len(entries))
	}

	if entries[0].Name != "curl" || entries[0].Status != "update_available" {
		t.Errorf("curl entry = %+v", entries[0])
	}

	if entries[1].Name != "socat" || entries[1].Status != "available" {
		t.Errorf("socat entry = %+v", entries[1])
	}
}

func TestExecListEmptyOutput(t *testing.T) {
	runner := func(_ context.Context, _ ...string) (string, int, error) {
		return "", 0, nil
	}

	result, err := newExecManagerWithRunner(t, runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages

	if entries == nil || len(entries) != 0 {
		t.Errorf("entries = %#v, want non-nil empty slice", entries)
	}
}

func TestStubListStatusesAndTransitions(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()

	result, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages
	statuses := map[string]string{}

	for _, entry := range entries {
		statuses[entry.Name] = entry.Status
	}

	want := map[string]string{
		"bash": "installed", "curl": "available", "daemonize": "available",
		"jq": "update_available", "socat": "available", "ttyd": "available",
	}

	if !mapsEqual(statuses, want) {
		t.Errorf("statuses = %v, want %v", statuses, want)
	}

	if err := m.Install(ctx, []string{"curl"}); err != nil {
		t.Fatal(err)
	}

	if err := m.Remove(ctx, []string{"bash"}); err != nil {
		t.Fatal(err)
	}

	if err := m.Upgrade(ctx, []string{"jq"}); err != nil {
		t.Fatal(err)
	}

	result, err = m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}

	entries = result.Packages

	for _, entry := range entries {
		if entry.Name == "curl" && (entry.Status != "installed" || entry.Version != "8.0.1-1") {
			t.Errorf("curl after install = %+v", entry)
		}

		if entry.Name == "bash" && entry.Status != "available" {
			t.Errorf("bash after remove = %+v", entry)
		}

		if entry.Name == "jq" && (entry.Status != "installed" || entry.Version != "1.7-1" || entry.NewVersion != "") {
			t.Errorf("jq after upgrade = %+v", entry)
		}
	}
}

func mapsEqual(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}

	for key, value := range want {
		if got[key] != value {
			return false
		}
	}

	return true
}

// TestExecMutationsSerialize verifies mutating operations never run concurrently:
// while the first runner is held open, no other mutation may enter. Channel-driven —
// the only timing element is the negative-assertion window, which can only produce
// a false FAILURE if the gate is broken, never a false pass of a working gate.
func TestExecMutationsSerialize(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	stateDir := t.TempDir()
	m := &execManager{
		logger:     logger,
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
	m.runner = func(_ context.Context, _ ...string) (string, int, error) {
		entered <- struct{}{}

		<-release

		return "", 0, nil
	}

	var wg sync.WaitGroup

	for i := 0; i < 4; i++ {
		wg.Add(1)

		go func() {
			defer wg.Done()

			if err := m.Install(context.Background(), []string{"ttyd"}); err != nil {
				t.Errorf("Install: %v", err)
			}
		}()
	}

	<-entered

	select {
	case <-entered:
		t.Fatal("a second mutation entered the runner while the gate was held")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	wg.Wait()

	if got := len(entered); got != 3 {
		t.Fatalf("runner entries after release = %d, want 3", got)
	}
}

// TestExecGateWaitAbortsOnCancel verifies a canceled context aborts a gate wait
// immediately instead of queueing behind a long-running mutation. The holder signals
// gate acquisition from inside its runner — no wall-clock sleeps.
func TestExecGateWaitAbortsOnCancel(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	acquired := make(chan struct{})
	holdRelease := make(chan struct{})
	stateDir := t.TempDir()
	m := &execManager{
		logger:     logger,
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
	m.runner = func(ctx context.Context, _ ...string) (string, int, error) {
		close(acquired)

		select {
		case <-holdRelease:
		case <-ctx.Done():
		}

		return "", 0, nil
	}

	holderDone := make(chan struct{})

	go func() {
		defer close(holderDone)

		_ = m.Install(context.Background(), []string{"ttyd"})
	}()

	<-acquired

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	err := m.Install(ctx, []string{"daemonize"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Install with canceled ctx = %v, want context.Canceled", err)
	}

	close(holdRelease)
	<-holderDone
}

// TestExecMutationsAbortWhenCanceled pins the contract on every exec mutating
// method: an already-canceled context aborts at the gate, before the runner runs.
func TestExecMutationsAbortWhenCanceled(t *testing.T) {
	stateDir := t.TempDir()
	m := &execManager{
		logger:     discard(),
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
	m.runner = func(_ context.Context, args ...string) (string, int, error) {
		t.Errorf("runner invoked despite canceled context: %v", args)

		return "", 0, nil
	}

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	checks := []struct {
		name string
		call func() error
	}{
		{"Install", func() error { return m.Install(ctx, []string{"ttyd"}) }},
		{"Remove", func() error { return m.Remove(ctx, []string{"ttyd"}) }},
		{"Upgrade", func() error { return m.Upgrade(ctx, []string{"ttyd"}) }},
		{"Update", func() error { return m.Update(ctx) }},
	}

	for _, c := range checks {
		if err := c.call(); !errors.Is(err, context.Canceled) {
			t.Errorf("exec %s with canceled ctx = %v, want context.Canceled", c.name, err)
		}
	}
}

// TestStubHonorsCancellation pins the Manager cancellation contract on EVERY method
// of the stub: each must return the context error once ctx is done.
func TestStubHonorsCancellation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := newStub(logger)

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	checks := []struct {
		name string
		call func() error
	}{
		{"Install", func() error { return m.Install(ctx, []string{"ttyd"}) }},
		{"Remove", func() error { return m.Remove(ctx, []string{"ttyd"}) }},
		{"Upgrade", func() error { return m.Upgrade(ctx, []string{"ttyd"}) }},
		{"Update", func() error { return m.Update(ctx) }},

		{"ListInstalled", func() error { _, err := m.ListInstalled(ctx); return err }},

		{"ListAvailable", func() error { _, err := m.ListAvailable(ctx); return err }},

		{"List", func() error { _, err := m.List(ctx); return err }},
	}

	for _, c := range checks {
		if err := c.call(); !errors.Is(err, context.Canceled) {
			t.Errorf("stub %s with canceled ctx = %v, want context.Canceled", c.name, err)
		}
	}
}
