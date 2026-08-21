package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func writeFakeProc(t *testing.T, root string, pid int, cmdline []byte, comm, status string) {
	t.Helper()

	dir := filepath.Join(root, strconv.Itoa(pid))

	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	if cmdline != nil {
		if err := os.WriteFile(filepath.Join(dir, "cmdline"), cmdline, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if comm != "" {
		if err := os.WriteFile(filepath.Join(dir, "comm"), []byte(comm), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if status != "" {
		if err := os.WriteFile(filepath.Join(dir, "status"), []byte(status), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadProcSnapshotNormalizesIdentityAndSkipsZombies(t *testing.T) {
	root := t.TempDir()

	writeFakeProc(t, root, 1516,
		[]byte("/usr/sbin/ntpd\x00--foreground\x00"),
		"ntpd\n",
		"Name:\tntpd\nState:\tS (sleeping)\n",
	)
	writeFakeProc(t, root, 1517,
		[]byte("/usr/sbin/ntpd\x00"),
		"ntpd\n",
		"Name:\tntpd\nState:\tZ (zombie)\n",
	)
	writeFakeProc(t, root, 1518, nil, "", "")

	if err := os.WriteFile(filepath.Join(root, "README"), []byte("not a pid"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := readProcSnapshot(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != 1 || got[0].pid != 1516 || got[0].cmdline != "/usr/sbin/ntpd --foreground" || got[0].comm != "ntpd" || got[0].zombie {
		t.Fatalf("snapshot = %+v, want one normalized live record", got)
	}
}

func TestReadProcSnapshotTruncatesBoundedFiles(t *testing.T) {
	root := t.TempDir()

	writeFakeProc(t, root, 99,
		[]byte(strings.Repeat("x", cmdlineReadLimit+100)),
		strings.Repeat("c", commReadLimit+100),
		"State:\tS "+strings.Repeat("s", statusReadLimit+100),
	)
	writeFakeProc(t, root, 100,
		[]byte("/bin/late-zombie"),
		"late-zombie\n",
		strings.Repeat("x", statusReadLimit)+"\nState:\tZ (zombie)\n",
	)

	got, err := readProcSnapshot(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}

	byPID := make(map[int]procRecord, len(got))

	for _, record := range got {
		byPID[record.pid] = record
	}

	record99, ok99 := byPID[99]
	record100, ok100 := byPID[100]

	if len(byPID) != 2 || !ok99 || !ok100 {
		t.Fatalf("snapshot length = %d, want 2 live records", len(byPID))
	}

	if len(record99.cmdline) > cmdlineReadLimit || len(record99.comm) > commReadLimit || record99.zombie {
		t.Fatalf("record 99 exceeded identity limits or lost early State line: %+v", record99)
	}

	if record100.zombie {
		t.Fatalf("record 100 saw State: Z beyond statusReadLimit: %+v", record100)
	}
}

func TestReadProcSnapshotHonorsCanceledContext(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	_, err := readProcSnapshot(ctx, root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func writeFakePIDFile(t *testing.T, path, content string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDeriveProcessNames(t *testing.T) {
	tests := []struct {
		name, fullName, serviceName, baseName string
	}{
		{name: "S20200foo", fullName: "S20200foo", serviceName: "20200foo", baseName: "foo"},
		{name: "S10x0", fullName: "S10x0", serviceName: "10x0", baseName: "x0"},
	}

	for _, test := range tests {
		fullName, serviceName, baseName := deriveProcessNames(test.name)

		if fullName != test.fullName || serviceName != test.serviceName || baseName != test.baseName {
			t.Errorf("deriveProcessNames(%q) = %q, %q, %q; want %q, %q, %q", test.name, fullName, serviceName, baseName, test.fullName, test.serviceName, test.baseName)
		}
	}
}

func TestResolvePIDUsesFirstWinningSourceAndLowestPIDWithinIt(t *testing.T) {
	m := testExecManager(t, nil)
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{
			{pid: 300, cmdline: "/opt/bin/daemon", comm: "daemon"},
			{pid: 200, cmdline: "/opt/bin/daemon --worker", comm: "daemon"},
			{pid: 100, cmdline: "/opt/bin/other", comm: "other"},
		}, nil
	}

	pid, err := m.resolvePIDWithMeta(context.Background(), "S99svc", scriptMeta{
		procs:  "daemon",
		name:   "other",
		daemon: "other",
	})
	if err != nil {
		t.Fatal(err)
	}

	if pid != 200 {
		t.Fatalf("pid = %d, want 200 from PROCS, not pooled PID 100", pid)
	}
}

func TestResolvePIDValidatesExplicitPIDFileAgainstSnapshot(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "svc.pid")

	writeFakePIDFile(t, pidPath, "42\n")

	tests := []struct {
		name    string
		records []procRecord
		want    int
	}{
		{
			name:    "live",
			records: []procRecord{{pid: 42, comm: "svc"}},
			want:    42,
		},
		{
			name:    "absent",
			records: []procRecord{{pid: 43, comm: "other"}},
			want:    0,
		},
		{
			name:    "injected zombie",
			records: []procRecord{{pid: 42, comm: "svc", zombie: true}},
			want:    0,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			m := testExecManager(t, nil)
			m.procSnapshot = func(context.Context) ([]procRecord, error) {
				return test.records, nil
			}

			got, err := m.resolvePIDWithMeta(context.Background(), "S99svc", scriptMeta{pidFile: pidPath})
			if err != nil {
				t.Fatal(err)
			}

			if got != test.want {
				t.Fatalf("pid = %d, want %d", got, test.want)
			}
		})
	}
}

func TestResolvePIDUsesConfiguredMndwdPIDFile(t *testing.T) {
	m := testExecManager(t, nil)
	m.pidfile = filepath.Join(t.TempDir(), "mndwd.pid")

	writeFakePIDFile(t, m.pidfile, "42\n")

	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 42, comm: "mndwd"}}, nil
	}

	got, err := m.resolvePIDWithMeta(context.Background(), "S70mndwd", scriptMeta{})
	if err != nil {
		t.Fatal(err)
	}

	if got != 42 {
		t.Fatalf("pid = %d, want 42", got)
	}
}

func TestResolvePIDUsesConventionalPIDFileRootsAndOrdering(t *testing.T) {
	for _, rootName := range []string{"tmp", "var-run", "opt-var-run"} {
		t.Run(rootName, func(t *testing.T) {
			root := t.TempDir()
			m := testExecManager(t, nil)
			m.pidFileDirs = []string{root}

			writeFakePIDFile(t, filepath.Join(root, "foo.pid"), "77\n")

			m.procSnapshot = func(context.Context) ([]procRecord, error) {
				return []procRecord{{pid: 77, comm: "foo"}}, nil
			}

			got, err := m.resolvePIDWithMeta(context.Background(), "S99foo", scriptMeta{})
			if err != nil {
				t.Fatal(err)
			}

			if got != 77 {
				t.Fatalf("pid = %d, want 77 from conventional root", got)
			}
		})
	}

	t.Run("base name before full name", func(t *testing.T) {
		root := t.TempDir()
		m := testExecManager(t, nil)
		m.pidFileDirs = []string{root}

		writeFakePIDFile(t, filepath.Join(root, "S99foo.pid"), "100\n")
		writeFakePIDFile(t, filepath.Join(root, "foo"), "200\n")

		m.procSnapshot = func(context.Context) ([]procRecord, error) {
			return []procRecord{{pid: 100, comm: "foo"}, {pid: 200, comm: "foo"}}, nil
		}

		got, err := m.resolvePIDWithMeta(context.Background(), "S99foo", scriptMeta{})
		if err != nil {
			t.Fatal(err)
		}

		if got != 200 {
			t.Fatalf("pid = %d, want 200 from base-name candidate before full-name candidate", got)
		}
	})
}

func TestResolvePIDUsesMetadataAndNameFallbacks(t *testing.T) {
	tests := []struct {
		name    string
		meta    scriptMeta
		records []procRecord
		want    int
	}{
		{name: "NAME", meta: scriptMeta{name: "cron"}, records: []procRecord{{pid: 10, cmdline: "/usr/sbin/cron -f"}}, want: 10},
		{name: "DAEMON", meta: scriptMeta{daemon: "/opt/sbin/ntpd"}, records: []procRecord{{pid: 11, cmdline: "/opt/sbin/ntpd --foreground"}}, want: 11},
		{name: "base name", meta: scriptMeta{}, records: []procRecord{{pid: 12, cmdline: "/opt/bin/foo"}}, want: 12},
		{name: "full name", meta: scriptMeta{}, records: []procRecord{{pid: 13, cmdline: "/opt/bin/S99foo"}}, want: 13},
		{name: "script basename", meta: scriptMeta{script: "/opt/etc/init.d/custom-script"}, records: []procRecord{{pid: 14, cmdline: "/opt/bin/custom-script --run"}}, want: 14},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			m := testExecManager(t, nil)
			m.procSnapshot = func(context.Context) ([]procRecord, error) {
				return test.records, nil
			}

			got, err := m.resolvePIDWithMeta(context.Background(), "S99foo", test.meta)
			if err != nil {
				t.Fatal(err)
			}

			if got != test.want {
				t.Fatalf("pid = %d, want %d", got, test.want)
			}
		})
	}
}

func TestResolvePIDPrefersFullPathBeforePathBasename(t *testing.T) {
	m := testExecManager(t, nil)
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{
			{pid: 50, cmdline: "/usr/sbin/ntpd --foreground", comm: "ntpd"},
			{pid: 60, cmdline: "/opt/sbin/ntpd --foreground", comm: "ntpd"},
		}, nil
	}

	got, err := m.resolvePIDWithMeta(context.Background(), "S77ntpd", scriptMeta{procs: "/opt/sbin/ntpd"})
	if err != nil {
		t.Fatal(err)
	}

	if got != 60 {
		t.Fatalf("pid = %d, want full-path match PID 60 before basename PID 50", got)
	}
}

func TestResolvePIDUsesCommFallbackWithKernelTruncation(t *testing.T) {
	m := testExecManager(t, nil)
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 15, comm: "long-process-na"}}, nil
	}

	got, err := m.resolvePIDWithMeta(context.Background(), "S99long-process-name", scriptMeta{})
	if err != nil {
		t.Fatal(err)
	}

	if got != 15 {
		t.Fatalf("pid = %d, want 15 from truncated comm fallback", got)
	}
}

func TestResolvePIDReturnsZeroForEmptyOrUnrelatedRecords(t *testing.T) {
	m := testExecManager(t, nil)
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 1, cmdline: "/bin/other", comm: "other"}}, nil
	}

	got, err := m.resolvePIDWithMeta(context.Background(), "S99", scriptMeta{})
	if err != nil {
		t.Fatal(err)
	}

	if got != 0 {
		t.Fatalf("pid = %d, want 0", got)
	}
}
