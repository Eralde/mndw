package listen

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func testConfig(dir, bindAddr string) Config {
	return Config{
		BindAddr:      bindAddr,
		PersistPath:   filepath.Join(dir, "frontend-port"),
		SeedPath:      filepath.Join(dir, "lighttpd-port"),
		DefaultPort:   DefaultPort,
		FallbackPorts: DefaultFallbackPorts,
		RetryAttempts: 1,
		RetryDelay:    time.Millisecond,
	}
}

func freePort(t *testing.T, bindAddr string) int {
	t.Helper()

	probe, err := net.Listen("tcp", net.JoinHostPort(bindAddr, "0"))
	if err != nil {
		t.Fatal(err)
	}

	port := probe.Addr().(*net.TCPAddr).Port

	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}

	return port
}

func writePort(t *testing.T, path string, port int) {
	t.Helper()

	if err := os.WriteFile(path, []byte(strconv.Itoa(port)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSelectPersistsChosenPort(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(dir, "127.0.0.1")
	cfg.DefaultPort = freePort(t, "127.0.0.1")
	cfg.FallbackPorts = []int{cfg.DefaultPort}
	selection, err := Select(cfg)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	ln, port := selection.Listener, selection.Port

	defer ln.Close()

	if port <= 0 {
		t.Fatalf("expected positive port, got %d", port)
	}

	data, err := os.ReadFile(cfg.PersistPath)
	if err != nil {
		t.Fatalf("read persisted: %v", err)
	}

	if string(data) != strconv.Itoa(port) {
		t.Fatalf("persisted port = %q, want %d", data, port)
	}
}

func TestDefaultPortIs1189(t *testing.T) {
	if DefaultPort != 1189 {
		t.Fatalf("default port = %d, want 1189", DefaultPort)
	}
}

func TestSelectPrefersPersistedPort(t *testing.T) {
	dir := t.TempDir()
	pref := freePort(t, "127.0.0.1")
	cfg := testConfig(dir, "127.0.0.1")

	writePort(t, cfg.PersistPath, pref)

	selection, err := Select(cfg)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	ln, port := selection.Listener, selection.Port

	defer ln.Close()

	if port != pref {
		t.Fatalf("expected persisted port %d, got %d", pref, port)
	}
}

func TestSelectFallsBackWhenPreferredBusy(t *testing.T) {
	dir := t.TempDir()
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer busy.Close()

	busyPort := busy.Addr().(*net.TCPAddr).Port

	cfg := testConfig(dir, "127.0.0.1")
	cfg.DefaultPort = busyPort
	free := freePort(t, "127.0.0.1")
	cfg.FallbackPorts = []int{free}

	selection, err := Select(cfg)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	ln, port := selection.Listener, selection.Port

	defer ln.Close()

	if port != free {
		t.Fatalf("expected fallback %d, got %d", free, port)
	}

	if !selection.UsedFallback || selection.PreferredPort != busyPort {
		t.Fatalf("selection fallback details = %+v, want preferred %d", selection, busyPort)
	}
}

func TestSelectStopsAfterNonAddressInUsePreferredError(t *testing.T) {
	dir := t.TempDir()
	fallback := freePort(t, "127.0.0.1")
	cfg := testConfig(dir, "127.0.0.1")
	cfg.DefaultPort = 70000
	cfg.FallbackPorts = []int{fallback}

	if selection, err := Select(cfg); err == nil {
		_ = selection.Listener.Close()
		t.Fatal("Select continued to fallback after preferred bind returned a non-busy error")
	} else if !strings.Contains(err.Error(), "127.0.0.1:70000") {
		t.Fatalf("preferred bind error = %v, want preferred address", err)
	}

	probe, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(fallback)))
	if err != nil {
		t.Fatalf("fallback port was unexpectedly bound: %v", err)
	}
	_ = probe.Close()
}

func TestSelectMigratesSeedWhenNoPersisted(t *testing.T) {
	dir := t.TempDir()
	seed := freePort(t, "127.0.0.1")
	cfg := testConfig(dir, "127.0.0.1")

	writePort(t, cfg.SeedPath, seed)

	selection, err := Select(cfg)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	ln, port := selection.Listener, selection.Port

	defer ln.Close()

	if port != seed {
		t.Fatalf("expected seeded port %d, got %d", seed, port)
	}
}

func TestSelectExhaustionErrors(t *testing.T) {
	dir := t.TempDir()
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer busy.Close()

	busyPort := busy.Addr().(*net.TCPAddr).Port
	busyFallback, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busyFallback.Close()
	busyFallbackPort := busyFallback.Addr().(*net.TCPAddr).Port

	cfg := testConfig(dir, "127.0.0.1")
	cfg.DefaultPort = busyPort
	cfg.FallbackPorts = []int{busyPort, busyFallbackPort}

	if _, err := Select(cfg); err == nil {
		t.Fatal("expected exhaustion error, got nil")
	} else {
		if !errors.Is(err, syscall.EADDRINUSE) {
			t.Fatalf("exhaustion error = %v, want wrapped EADDRINUSE", err)
		}

		if !strings.Contains(err.Error(), "tried preferred") || !strings.Contains(err.Error(), "127.0.0.1:"+strconv.Itoa(busyPort)) {
			t.Fatalf("exhaustion error = %v, want existing summary and preferred address", err)
		}
	}
}

func TestDefaultFallbackPortsAreAscending(t *testing.T) {
	previous := 1188

	for _, port := range DefaultFallbackPorts {
		if port < 1189 || port > 1289 {
			t.Fatalf("fallback port %d out of range", port)
		}

		if port <= previous {
			t.Fatalf("fallback ports are not ascending at %d", port)
		}

		previous = port
	}
}
