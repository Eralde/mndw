package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func serviceDiscard() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func writeInitScript(t *testing.T, dir, name string, executable bool) {
	t.Helper()

	path := filepath.Join(dir, name)

	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if executable {
		if err := os.Chmod(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func writeInitScriptBody(t *testing.T, dir, name, body string) {
	t.Helper()

	path := filepath.Join(dir, name)

	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func usageRunner() func(context.Context, ...string) (string, int, error) {
	return func(_ context.Context, args ...string) (string, int, error) {
		return "Usage: " + args[len(args)-1], 1, nil
	}
}

func testExecManager(t *testing.T, runner func(context.Context, ...string) (string, int, error)) *execManager {
	t.Helper()

	dir := t.TempDir()

	return &execManager{
		logger:       serviceDiscard(),
		runner:       runner,
		initDir:      dir,
		pidfile:      filepath.Join(dir, "mndwd.pid"),
		probeTimeout: time.Second,
		statusCap:    4,
		gate:         make(chan struct{}, 1),
		statusGate:   make(chan struct{}, 4),
		procSnapshot: func(context.Context) ([]procRecord, error) { return nil, nil },
		procRoot:     filepath.Join(dir, "proc"),
		pidFileDirs:  []string{filepath.Join(dir, "tmp")},
		clock:        time.Now,
	}
}

func TestListDiscoversBothPrefixesWithoutRunningScripts(t *testing.T) {
	var calls int
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		calls++

		return "", 0, nil
	})

	writeInitScript(t, m.initDir, "S99foo", true)
	writeInitScript(t, m.initDir, "K50bar", true)
	writeInitScript(t, m.initDir, "README", true)
	writeInitScript(t, m.initDir, "S01noexec", false)

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if calls != 0 {
		t.Fatalf("List runner calls = %d, want 0", calls)
	}

	if len(got) != 2 || got[0].Name != "K50bar" || got[1].Name != "S99foo" {
		t.Fatalf("services = %+v", got)
	}

	if got[0].Label != "bar" || got[0].EnabledAtBoot || got[0].State != "unknown" {
		t.Errorf("K50bar = %+v", got[0])
	}

	if got[1].Label != "foo" || !got[1].EnabledAtBoot || got[1].Protected {
		t.Errorf("S99foo = %+v", got[1])
	}
}

func TestListDiscoversExecutableSymlinkTarget(t *testing.T) {
	m := testExecManager(t, nil)
	target := filepath.Join(t.TempDir(), "real-service")

	if err := os.WriteFile(target, []byte("#!/bin/sh\nPROCS=real-service\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(target, filepath.Join(m.initDir, "S99linked")); err != nil {
		t.Fatal(err)
	}

	nonExecutable := filepath.Join(t.TempDir(), "non-executable")

	if err := os.WriteFile(nonExecutable, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(nonExecutable, filepath.Join(m.initDir, "S98noexec")); err != nil {
		t.Fatal(err)
	}

	directory := filepath.Join(t.TempDir(), "directory")

	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(directory, filepath.Join(m.initDir, "S97directory")); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(target, filepath.Join(m.initDir, "README")); err != nil {
		t.Fatal(err)
	}

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != 1 || got[0].Name != "S99linked" {
		t.Fatalf("services = %+v, want executable symlink-backed service only", got)
	}

	if got[0].Pid != 0 || got[0].State != "unknown" {
		t.Fatalf("entry = %+v, want List to remain PID-free and unprobed", got[0])
	}
}

func TestListReadsEnabledOverride(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		t.Fatal("List must not call the runner")

		return "", 0, nil
	})

	writeInitScriptBody(t, m.initDir, "S99off", "#!/bin/sh\nENABLED=no\n")
	writeInitScriptBody(t, m.initDir, "K50on", "#!/bin/sh\nENABLED=yes\n")

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	byName := map[string]ServiceEntry{}

	for _, entry := range got {
		byName[entry.Name] = entry
	}

	if byName["S99off"].EnabledAtBoot {
		t.Errorf("S99off enabledAtBoot = true, want false (ENABLED=no overrides S prefix)")
	}

	if !byName["K50on"].EnabledAtBoot {
		t.Errorf("K50on enabledAtBoot = false, want true (ENABLED=yes overrides K prefix)")
	}
}

func TestListFallsBackToPrefixWithoutEnabled(t *testing.T) {
	m := testExecManager(t, nil)

	writeInitScriptBody(t, m.initDir, "S99foo", "#!/bin/sh\n")
	writeInitScriptBody(t, m.initDir, "K50bar", "#!/bin/sh\n")

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	byName := map[string]ServiceEntry{}

	for _, entry := range got {
		byName[entry.Name] = entry
	}

	if !byName["S99foo"].EnabledAtBoot {
		t.Errorf("S99foo enabledAtBoot = false, want true (S prefix default)")
	}

	if byName["K50bar"].EnabledAtBoot {
		t.Errorf("K50bar enabledAtBoot = true, want false (K prefix default)")
	}
}

func TestListReturnsUnavailableForMissingDirectory(t *testing.T) {
	m := testExecManager(t, nil)
	m.initDir = filepath.Join(t.TempDir(), "missing")

	_, err := m.List(context.Background())
	if !errors.Is(err, ErrServiceUnavailable) {
		t.Fatalf("List error = %v, want ErrServiceUnavailable", err)
	}
}

func TestStatusUnknownVerbFallsThroughToCheck(t *testing.T) {
	m := testExecManager(t, func(_ context.Context, args ...string) (string, int, error) {
		if args[len(args)-1] == "status" {
			return "Usage: S99foo {start|stop|check}", 1, nil
		}

		return "alive", 0, nil
	})

	writeInitScript(t, m.initDir, "S99foo", true)

	got, err := m.Status(context.Background(), "S99foo")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" {
		t.Fatalf("state = %q, want running", got.State)
	}
}

func TestStatusReportsPIDFromCmdlineResolver(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		return "running", 0, nil
	})
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 1516, cmdline: "/opt/sbin/ntpd --foreground", comm: "ntpd", exe: "/opt/sbin/ntpd"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S77ntpd", "#!/bin/sh\nPROCS=ntpd\n")

	got, err := m.Status(context.Background(), "S77ntpd")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" || got.Pid != 1516 {
		t.Fatalf("entry = %+v, want running with PID 1516", got)
	}
}

func TestStatusPreservesKnownStateWhenSnapshotFails(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		return "running", 0, nil
	})
	called := false
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		called = true

		return nil, errors.New("proc unavailable")
	}

	writeInitScript(t, m.initDir, "S99foo", true)

	got, err := m.Status(context.Background(), "S99foo")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" || got.Pid != 0 {
		t.Fatalf("entry = %+v, want running with omitted PID", got)
	}

	if !called {
		t.Fatal("Status did not attempt PID resolution")
	}
}

func TestStatusKnownStoppedIgnoresMatchingProcess(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		return "stopped", 1, nil
	})
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 1516, cmdline: "/opt/sbin/ntpd --foreground", comm: "ntpd", exe: "/opt/sbin/ntpd"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S77ntpd", "#!/bin/sh\nPROCS=ntpd\n")

	got, err := m.Status(context.Background(), "S77ntpd")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "stopped" || got.Pid != 0 {
		t.Fatalf("entry = %+v, want stopped without PID", got)
	}
}

func TestStatusFallbackUsesResolverPID(t *testing.T) {
	m := testExecManager(t, usageRunner())
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 100, cmdline: "/opt/sbin/transmission-daemon --foreground", comm: "transmission-daemon", exe: "/opt/sbin/transmission-daemon"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S99transmission",
		"#!/bin/sh\nPROCS=transmission-daemon\n")

	got, err := m.Status(context.Background(), "S99transmission")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" || got.Pid != 100 {
		t.Fatalf("entry = %+v, want running with PID 100", got)
	}
}

func TestStatusIgnoresFirmwareProcessForOptService(t *testing.T) {
	m := testExecManager(t, usageRunner())
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 726, cmdline: "/usr/sbin/dropbear", comm: "dropbear", exe: "/usr/sbin/dropbear"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "K51dropbear", "#!/bin/sh\nPROCS=dropbear\n")

	got, err := m.Status(context.Background(), "K51dropbear")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "unknown" || got.Pid != 0 {
		t.Fatalf("entry = %+v, want unknown without firmware PID", got)
	}
}

func TestStatusFallbackSnapshotFailureReturnsUnknown(t *testing.T) {
	m := testExecManager(t, usageRunner())
	pidPath := filepath.Join(t.TempDir(), "svc.pid")

	if err := os.WriteFile(pidPath, []byte("42\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	called := false
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		called = true

		return nil, errors.New("proc unavailable")
	}

	writeInitScriptBody(t, m.initDir, "S99svc", "#!/bin/sh\nPID_FILE=\""+pidPath+"\"\n")

	got, err := m.Status(context.Background(), "S99svc")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "unknown" || got.Pid != 0 {
		t.Fatalf("entry = %+v, want unknown without PID", got)
	}

	if !called {
		t.Fatal("fallback liveness did not attempt PID resolution")
	}
}

func TestStatusKnownExitOneMeansStopped(t *testing.T) {
	m := testExecManager(t, func(_ context.Context, args ...string) (string, int, error) {
		if args[len(args)-1] == "status" {
			return "stopped", 1, nil
		}

		return "", 0, nil
	})

	writeInitScript(t, m.initDir, "S99foo", true)

	got, err := m.Status(context.Background(), "S99foo")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "stopped" {
		t.Fatalf("state = %q, want stopped", got.State)
	}
}

func TestStatusS70mndwdUsesSnapshotValidatedPidfile(t *testing.T) {
	m := testExecManager(t, func(_ context.Context, _ ...string) (string, int, error) {
		return "Usage: S70mndwd {start|stop|restart}", 1, nil
	})

	writeInitScript(t, m.initDir, "S70mndwd", true)

	if err := os.WriteFile(m.pidfile, []byte("42\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 42, cmdline: "/opt/bin/mndwd", comm: "mndwd", exe: "/opt/bin/mndwd"}}, nil
	}

	got, err := m.Status(context.Background(), "S70mndwd")
	if err != nil {
		t.Fatal(err)
	}

	if !got.Protected || got.State != "running" || got.Pid != 42 {
		t.Fatalf("entry = %+v", got)
	}
}

func TestStatusProcsFallbackReportsRunning(t *testing.T) {
	m := testExecManager(t, usageRunner())
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 100, cmdline: "/opt/sbin/transmission-daemon --foreground", comm: "transmission-daemon", exe: "/opt/sbin/transmission-daemon"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S99transmission",
		"#!/bin/sh\nPROCS=transmission-daemon\n")

	got, err := m.Status(context.Background(), "S99transmission")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" || got.Pid != 100 {
		t.Fatalf("entry = %+v, want running with PID 100", got)
	}
}

func TestStatusPidFileFallbackForOwnScript(t *testing.T) {
	m := testExecManager(t, usageRunner())
	pidPath := filepath.Join(t.TempDir(), "svc.pid")

	if err := os.WriteFile(pidPath, []byte("7\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 7, cmdline: "/opt/bin/svc", comm: "svc", exe: "/opt/bin/svc"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S99svc", "#!/bin/sh\nPID_FILE=\""+pidPath+"\"\n")

	got, err := m.Status(context.Background(), "S99svc")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" || got.Pid != 7 {
		t.Fatalf("entry = %+v, want running with PID 7", got)
	}
}

func TestStatusReportsPidFromPidfile(t *testing.T) {
	m := testExecManager(t, usageRunner())
	pidPath := filepath.Join(t.TempDir(), "svc.pid")

	if err := os.WriteFile(pidPath, []byte("4321\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 4321, cmdline: "/opt/bin/svc", comm: "svc", exe: "/opt/bin/svc"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S99svc", "#!/bin/sh\nPID_FILE=\""+pidPath+"\"\n")

	got, err := m.Status(context.Background(), "S99svc")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" {
		t.Fatalf("state = %q, want running", got.State)
	}

	if got.Pid != 4321 {
		t.Errorf("pid = %d, want 4321", got.Pid)
	}
}

func TestStatusReportsPidFromPidfileWhenStatusSucceeds(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		return "running", 0, nil
	})
	pidPath := filepath.Join(t.TempDir(), "svc.pid")

	if err := os.WriteFile(pidPath, []byte("4321\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 4321, cmdline: "/opt/bin/svc", comm: "svc", exe: "/opt/bin/svc"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S99svc", "#!/bin/sh\nPID_FILE=\""+pidPath+"\"\n")

	got, err := m.Status(context.Background(), "S99svc")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" {
		t.Fatalf("state = %q, want running", got.State)
	}

	if got.Pid != 4321 {
		t.Errorf("pid = %d, want 4321", got.Pid)
	}
}

func TestStatusProcsFallbackReportsPid(t *testing.T) {
	m := testExecManager(t, usageRunner())
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 101, cmdline: "/opt/sbin/transmission-daemon --foreground", comm: "transmission-daemon", exe: "/opt/sbin/transmission-daemon"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S99transmission",
		"#!/bin/sh\nPROCS=transmission-daemon\n")

	got, err := m.Status(context.Background(), "S99transmission")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" || got.Pid != 101 {
		t.Fatalf("entry = %+v, want running with PID 101", got)
	}
}

func TestStatusDeadPidfileReportsNoPid(t *testing.T) {
	m := testExecManager(t, usageRunner())
	pidPath := filepath.Join(t.TempDir(), "svc.pid")

	if err := os.WriteFile(pidPath, []byte("4321\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	writeInitScriptBody(t, m.initDir, "S99svc", "#!/bin/sh\nPID_FILE=\""+pidPath+"\"\n")

	got, err := m.Status(context.Background(), "S99svc")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "unknown" {
		t.Fatalf("state = %q, want unknown", got.State)
	}

	if got.Pid != 0 {
		t.Errorf("pid = %d, want 0 (dead pid is not reported)", got.Pid)
	}
}

func TestListReportsZeroPid(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		t.Fatal("List must not call the runner")

		return "", 0, nil
	})

	writeInitScriptBody(t, m.initDir, "S99svc", "#!/bin/sh\nPID_FILE=/tmp/whatever.pid\n")

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	for _, entry := range got {
		if entry.Pid != 0 {
			t.Errorf("%s pid = %d, want 0 (List does not probe)", entry.Name, entry.Pid)
		}
	}
}

func TestListEnrichesLivenessFromSnapshot(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		t.Fatal("List must not run per-script status verbs")

		return "", 0, nil
	})
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 1516, cmdline: "/opt/sbin/ntpd --foreground", comm: "ntpd", exe: "/opt/sbin/ntpd"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "S77ntpd", "#!/bin/sh\nPROCS=ntpd\n")
	writeInitScriptBody(t, m.initDir, "S99absent", "#!/bin/sh\nPROCS=absent\n")

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	byName := make(map[string]ServiceEntry, len(got))

	for _, entry := range got {
		byName[entry.Name] = entry
	}

	if running := byName["S77ntpd"]; running.State != "running" || running.Pid != 1516 {
		t.Errorf("S77ntpd = %+v, want running with PID 1516 from the shared snapshot", running)
	}

	if absent := byName["S99absent"]; absent.State != "unknown" || absent.Pid != 0 {
		t.Errorf("S99absent = %+v, want unknown with no PID when unmatched", absent)
	}
}

func TestListIgnoresFirmwareProcessForOptService(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		t.Fatal("List must not run per-script status verbs")

		return "", 0, nil
	})
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return []procRecord{{pid: 726, cmdline: "/usr/sbin/dropbear", comm: "dropbear", exe: "/usr/sbin/dropbear"}}, nil
	}

	writeInitScriptBody(t, m.initDir, "K51dropbear", "#!/bin/sh\nPROCS=dropbear\n")

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != 1 || got[0].State != "unknown" || got[0].Pid != 0 {
		t.Fatalf("services = %+v, want unknown without firmware PID", got)
	}
}

func TestListSurvivesSnapshotFailure(t *testing.T) {
	m := testExecManager(t, nil)
	m.procSnapshot = func(context.Context) ([]procRecord, error) {
		return nil, errors.New("proc unavailable")
	}

	writeInitScript(t, m.initDir, "S99foo", true)

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != 1 || got[0].State != "unknown" || got[0].Pid != 0 {
		t.Fatalf("services = %+v, want unenriched list when the snapshot fails", got)
	}
}

func TestListReportsAutostartPinned(t *testing.T) {
	m := testExecManager(t, func(context.Context, ...string) (string, int, error) {
		t.Fatal("List must not call the runner")

		return "", 0, nil
	})

	writeInitScriptBody(t, m.initDir, "S99pinned", "#!/bin/sh\nENABLED=no\n")
	writeInitScriptBody(t, m.initDir, "S98free", "#!/bin/sh\n")

	got, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	byName := make(map[string]ServiceEntry, len(got))

	for _, entry := range got {
		byName[entry.Name] = entry
	}

	if entry := byName["S99pinned"]; !entry.AutostartPinned || entry.EnabledAtBoot {
		t.Errorf("pinned entry = pinned:%v enabled:%v, want pinned:true enabled:false", entry.AutostartPinned, entry.EnabledAtBoot)
	}

	if entry := byName["S98free"]; entry.AutostartPinned {
		t.Errorf("unpinned entry reported autostartPinned=true")
	}
}

func TestSetEnabledDisableRenamesPrefix(t *testing.T) {
	m := testExecManager(t, nil)

	writeInitScriptBody(t, m.initDir, "S99foo", "#!/bin/sh\n")

	got, err := m.SetEnabled(context.Background(), "S99foo", false)
	if err != nil {
		t.Fatal(err)
	}

	if got.Name != "K99foo" || got.EnabledAtBoot {
		t.Fatalf("got name=%q enabled=%v, want K99foo/false", got.Name, got.EnabledAtBoot)
	}

	if _, statErr := os.Stat(filepath.Join(m.initDir, "K99foo")); statErr != nil {
		t.Errorf("K99foo not on disk: %v", statErr)
	}

	if _, statErr := os.Stat(filepath.Join(m.initDir, "S99foo")); statErr == nil {
		t.Errorf("S99foo still on disk after disable")
	}
}

func TestSetEnabledEnableRenamesPrefix(t *testing.T) {
	m := testExecManager(t, nil)

	writeInitScriptBody(t, m.initDir, "K50bar", "#!/bin/sh\n")

	got, err := m.SetEnabled(context.Background(), "K50bar", true)
	if err != nil {
		t.Fatal(err)
	}

	if got.Name != "S50bar" || !got.EnabledAtBoot {
		t.Fatalf("got name=%q enabled=%v, want S50bar/true", got.Name, got.EnabledAtBoot)
	}
}

func TestSetEnabledIdempotent(t *testing.T) {
	m := testExecManager(t, nil)

	writeInitScriptBody(t, m.initDir, "S99foo", "#!/bin/sh\n")

	got, err := m.SetEnabled(context.Background(), "S99foo", true)
	if err != nil {
		t.Fatal(err)
	}

	if got.Name != "S99foo" {
		t.Fatalf("name = %q, want unchanged S99foo", got.Name)
	}

	if _, statErr := os.Stat(filepath.Join(m.initDir, "S99foo")); statErr != nil {
		t.Errorf("S99foo should be untouched: %v", statErr)
	}
}

func TestSetEnabledRefusesExplicitEnabledLine(t *testing.T) {
	m := testExecManager(t, nil)

	writeInitScriptBody(t, m.initDir, "S99foo", "#!/bin/sh\nENABLED=yes\n")

	_, err := m.SetEnabled(context.Background(), "S99foo", false)
	var pinned *EnabledPinnedError

	if !errors.As(err, &pinned) {
		t.Fatalf("err = %v, want *EnabledPinnedError", err)
	}

	if _, statErr := os.Stat(filepath.Join(m.initDir, "S99foo")); statErr != nil {
		t.Errorf("script must not be renamed when pinned: %v", statErr)
	}
}

func TestSetEnabledRefusesProtected(t *testing.T) {
	m := testExecManager(t, nil)

	writeInitScriptBody(t, m.initDir, "S70mndwd", "#!/bin/sh\n")

	_, err := m.SetEnabled(context.Background(), "S70mndwd", false)
	var protected *ProtectedServiceError

	if !errors.As(err, &protected) {
		t.Fatalf("err = %v, want *ProtectedServiceError", err)
	}
}

func TestSetEnabledRejectsUnknownName(t *testing.T) {
	m := testExecManager(t, nil)

	_, err := m.SetEnabled(context.Background(), "S99missing", true)
	var invalid *InvalidServiceError

	if !errors.As(err, &invalid) {
		t.Fatalf("err = %v, want *InvalidServiceError", err)
	}
}

func TestStubSeedsPinnedService(t *testing.T) {
	m := newStub(nil)
	entries, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	found := false

	for _, entry := range entries {
		if entry.Name == "S95pinned" {
			found = true

			if !entry.AutostartPinned {
				t.Fatal("S95pinned autostartPinned = false, want true")
			}
		}
	}

	if !found {
		t.Fatal("stub did not seed S95pinned")
	}

	_, err = m.SetEnabled(context.Background(), "S95pinned", false)
	var pinned *EnabledPinnedError

	if !errors.As(err, &pinned) {
		t.Fatalf("err = %v, want *EnabledPinnedError", err)
	}
}

func TestParsePidFileRejectsOversizedContent(t *testing.T) {
	_, ok := parsePidFile(strings.NewReader(strings.Repeat("7", pidFileReadLimit+1)))

	if ok {
		t.Fatal("parsePidFile accepted oversized content")
	}
}

func TestStatusProcsFallbackDeadReportsUnknown(t *testing.T) {
	m := testExecManager(t, usageRunner())

	writeInitScriptBody(t, m.initDir, "S99transmission",
		"#!/bin/sh\nPROCS=transmission-daemon\n")

	got, err := m.Status(context.Background(), "S99transmission")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "unknown" {
		t.Fatalf("state = %q, want unknown", got.State)
	}
}

func TestMutationVerifiesPostStateAndProtectsStop(t *testing.T) {
	state := "stopped"
	m := testExecManager(t, func(_ context.Context, args ...string) (string, int, error) {
		verb := args[len(args)-1]

		switch verb {
		case "status", "check":
			if state == "running" {
				return "", 0, nil
			}

			return "", 1, nil
		case "start":
			state = "running"

			return "", 0, nil
		default:
			return "", 0, nil
		}
	})

	writeInitScript(t, m.initDir, "S99foo", true)

	got, err := m.Start(context.Background(), "S99foo")
	if err != nil {
		t.Fatal(err)
	}

	if got.State != "running" {
		t.Fatalf("state = %q, want running", got.State)
	}

	protected := filepath.Join(m.initDir, "S70mndwd")

	if err := os.WriteFile(protected, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	_, err = m.Stop(context.Background(), "S70mndwd")
	var denied *ProtectedServiceError

	if !errors.As(err, &denied) {
		t.Fatalf("Stop protected error = %v", err)
	}
}

func TestMutationDeadlineWrapsTimeout(t *testing.T) {
	m := testExecManager(t, func(ctx context.Context, args ...string) (string, int, error) {
		if args[len(args)-1] == "status" || args[len(args)-1] == "check" {
			return "Usage: S99foo", 1, nil
		}

		<-ctx.Done()

		return "", 0, ctx.Err()
	})

	writeInitScript(t, m.initDir, "S99foo", true)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)

	defer cancel()

	_, err := m.Start(ctx, "S99foo")
	var timeout *ActionTimeoutError

	if !errors.As(err, &timeout) {
		t.Fatalf("Start error = %v, want ActionTimeoutError", err)
	}
}

func TestStubTransitions(t *testing.T) {
	m := New("stub", serviceDiscard())
	entry, err := m.Start(context.Background(), "K50dropbear")
	if err != nil {
		t.Fatal(err)
	}

	if entry.State != "running" {
		t.Fatalf("state = %q, want running", entry.State)
	}
}

func TestStatusCancellationStopsPromptly(t *testing.T) {
	started := make(chan struct{})
	m := testExecManager(t, func(ctx context.Context, _ ...string) (string, int, error) {
		close(started)
		<-ctx.Done()

		return "", 0, ctx.Err()
	})

	writeInitScript(t, m.initDir, "S99foo", true)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)

	go func() {
		_, err := m.Status(ctx, "S99foo")
		done <- err
	}()

	<-started
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Status did not stop after cancellation")
	}
}

func TestMutationGateSerializes(t *testing.T) {
	var mu sync.Mutex
	active := 0
	maxActive := 0
	state := "stopped"
	started := make(chan struct{}, 2)
	release := make(chan struct{}, 2)
	m := testExecManager(t, func(_ context.Context, args ...string) (string, int, error) {
		verb := args[len(args)-1]

		if verb == "status" || verb == "check" {
			mu.Lock()

			current := state

			mu.Unlock()

			if current == "running" {
				return "", 0, nil
			}

			return "", 1, nil
		}

		mu.Lock()

		active++

		if active > maxActive {
			maxActive = active
		}

		mu.Unlock()

		started <- struct{}{}

		<-release
		mu.Lock()

		active--
		state = "running"

		mu.Unlock()

		return "", 0, nil
	})

	writeInitScript(t, m.initDir, "S99foo", true)

	var wg sync.WaitGroup

	for i := 0; i < 2; i++ {
		wg.Add(1)

		go func() {
			defer wg.Done()

			_, _ = m.Start(context.Background(), "S99foo")
		}()
	}

	<-started

	select {
	case <-started:
		t.Fatal("second mutation entered runner before first was released")
	default:
	}

	release <- struct{}{}

	<-started

	release <- struct{}{}

	wg.Wait()

	if maxActive != 1 {
		t.Fatalf("max concurrent mutations = %d, want 1", maxActive)
	}
}
