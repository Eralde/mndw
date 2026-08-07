package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/mgmt"
	"mndwd/internal/opkg"
	"mndwd/internal/readiness"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// writeBuiltin creates a builtin plugin dir with a minimal valid widget manifest
// declaring the given opkg dependencies (none when pkgs is empty).
func writeBuiltin(t *testing.T, builtinDir, name string, pkgs []string) {
	t.Helper()

	m := map[string]any{
		"manifestVersion": 2,
		"name":            name,
		"version":         "0.1.0",
		"type":            "widget",
		"label":           name,
		"entry":           "index.js",
		"size":            map[string]int{"w": 4, "h": 3},
	}
	if len(pkgs) > 0 {
		m["backend"] = map[string]any{"opkg": pkgs}
	}

	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(builtinDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func builtinRegistry(t *testing.T, builtinDir string) *registry.Registry {
	t.Helper()

	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	return registry.New(store, filepath.Join(root, "user-plugins"), builtinDir)
}

func newTestCoordinator(t *testing.T, builtinDir string, mgr opkg.Manager, life daemonStarter, delays []time.Duration) (*startupCoordinator, *readiness.Tracker) {
	t.Helper()
	reg := builtinRegistry(t, builtinDir)
	tracker := readiness.New()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	return newStartupCoordinator(reg, mgr, life, tracker, delays, logger), tracker
}

// startRecorder records daemon Start invocations.
type startRecorder struct {
	mu    sync.Mutex
	names []string
}

func (r *startRecorder) Start(name, _, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names = append(r.names, name)

	return nil
}

func TestCoordinatorInstallsDeclaredPackages(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd", "daemonize"})
	writeBuiltin(t, builtinDir, "clock-widget", nil)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := opkg.New("stub", logger)
	coord, _ := newTestCoordinator(t, builtinDir, mgr, &startRecorder{}, nil)

	coord.PreRegister()
	coord.Run(context.Background())
	coord.Wait()

	installed, err := mgr.ListInstalled(context.Background())
	if err != nil {
		t.Fatalf("ListInstalled: %v", err)
	}
	for _, want := range []string{"ttyd", "daemonize"} {
		if !slices.Contains(installed, want) {
			t.Errorf("package %q not installed; installed = %v", want, installed)
		}
	}
}

// flakyManager fails the first `failures` Install calls and records every attempt.
type flakyManager struct {
	opkg.Manager
	failures int
	calls    [][]string
}

func (m *flakyManager) Install(_ context.Context, packages []string) error {
	m.calls = append(m.calls, packages)
	if len(m.calls) <= m.failures {
		return errors.New("simulated transient opkg failure")
	}

	return nil
}

func TestCoordinatorRetriesTransientFailure(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd", "daemonize"})

	mgr := &flakyManager{failures: 2}
	coord, tracker := newTestCoordinator(t, builtinDir, mgr, &startRecorder{}, []time.Duration{0, 0})

	coord.PreRegister()
	coord.Run(context.Background())
	coord.Wait()

	if len(mgr.calls) != 3 {
		t.Fatalf("expected 3 install attempts (2 failures + 1 success), got %d: %v", len(mgr.calls), mgr.calls)
	}
	if _, ok := tracker.Get("ttyd-widget"); ok {
		t.Fatal("successful install must clear readiness tracker entry")
	}
}

// stuckManager fails every Install for a marked package and records every attempt.
type stuckManager struct {
	opkg.Manager
	failing map[string]bool
	calls   [][]string
}

func (m *stuckManager) Install(_ context.Context, packages []string) error {
	m.calls = append(m.calls, packages)
	for _, p := range packages {
		if m.failing[p] {
			return errors.New("simulated persistent opkg failure")
		}
	}

	return nil
}

func TestCoordinatorContinuesAfterPersistentFailure(t *testing.T) {
	builtinDir := t.TempDir()
	// ListBuiltins walks the dir in lexical order, so a-widget installs first.
	writeBuiltin(t, builtinDir, "a-widget", []string{"socat"})
	writeBuiltin(t, builtinDir, "b-widget", []string{"ttyd"})

	mgr := &stuckManager{failing: map[string]bool{"socat": true}}
	coord, tracker := newTestCoordinator(t, builtinDir, mgr, &startRecorder{}, []time.Duration{0})

	coord.PreRegister()
	coord.Run(context.Background())
	coord.Wait()

	want := "[[socat] [socat] [ttyd]]"
	if got := fmt.Sprint(mgr.calls); got != want {
		t.Errorf("install calls = %v, want %s", mgr.calls, want)
	}
	if s, ok := tracker.Get("a-widget"); !ok || s != readiness.StateFailed {
		t.Errorf("a-widget = (%q, %v), want (failed, true)", s, ok)
	}
	if _, ok := tracker.Get("b-widget"); ok {
		t.Fatal("successful builtin must be ready")
	}
}

func TestPreRegisterMarksDepBuiltinsInstalling(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd"})
	writeBuiltin(t, builtinDir, "clock-widget", nil)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	coord, tracker := newTestCoordinator(t, builtinDir, opkg.New("stub", logger), &startRecorder{}, nil)

	coord.PreRegister()

	if s, ok := tracker.Get("ttyd-widget"); !ok || s != readiness.StateInstalling {
		t.Fatalf("ttyd-widget = (%q, %v), want (installing, true)", s, ok)
	}
	if _, ok := tracker.Get("clock-widget"); ok {
		t.Fatal("clock-widget declares no deps and must not be tracked")
	}
	if !coord.Deferred("ttyd-widget") || coord.Deferred("clock-widget") {
		t.Fatal("Deferred must reflect exactly the dep-declaring builtins")
	}
}

func writeBuiltinDaemon(t *testing.T, builtinDir, name string, pkgs []string) {
	t.Helper()

	m := map[string]any{
		"manifestVersion": 2,
		"name":            name,
		"version":         "0.1.0",
		"type":            "widget",
		"label":           name,
		"entry":           "index.js",
		"size":            map[string]int{"w": 4, "h": 3},
		"backend": map[string]any{
			"daemon": map[string]string{"start": "backend/start.sh", "stop": "backend/stop.sh"},
		},
	}
	if len(pkgs) > 0 {
		m["backend"].(map[string]any)["opkg"] = pkgs
	}

	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(builtinDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (l *eventLog) add(e string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, e)
}

type orderedManager struct {
	opkg.Manager
	log *eventLog
}

func (m *orderedManager) Install(_ context.Context, packages []string) error {
	m.log.add("install-done:" + strings.Join(packages, ","))

	return nil
}

type orderedStarter struct {
	log *eventLog
}

func (s *orderedStarter) Start(name, _, _ string) error {
	s.log.add("start:" + name)

	return nil
}

func TestCoordinatorStartsDaemonAfterInstall(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltinDaemon(t, builtinDir, "ttyd-widget", []string{"ttyd"})

	log := &eventLog{}
	coord, tracker := newTestCoordinator(t, builtinDir, &orderedManager{log: log}, &orderedStarter{log: log}, nil)

	coord.PreRegister()
	coord.Run(context.Background())
	coord.Wait()

	want := "[install-done:ttyd start:ttyd-widget]"
	if got := fmt.Sprint(log.events); got != want {
		t.Fatalf("event order = %v, want %s", log.events, want)
	}
	if !coord.Started("ttyd-widget") {
		t.Fatal("Started must report the invoked start hook")
	}
	if _, ok := tracker.Get("ttyd-widget"); ok {
		t.Fatal("plugin must be ready after install + start")
	}
}

type blockingInstallManager struct {
	opkg.Manager
	started chan struct{}
}

func (m *blockingInstallManager) Install(ctx context.Context, _ []string) error {
	close(m.started)
	<-ctx.Done()

	return ctx.Err()
}

func TestCoordinatorCancellationDuringInstall(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltinDaemon(t, builtinDir, "ttyd-widget", []string{"ttyd"})

	ctx, cancel := context.WithCancel(context.Background())
	mgr := &blockingInstallManager{started: make(chan struct{})}
	recorder := &startRecorder{}
	coord, tracker := newTestCoordinator(t, builtinDir, mgr, recorder, nil)
	coord.PreRegister()
	coord.Run(ctx)
	<-mgr.started
	cancel()

	done := make(chan struct{})
	go func() {
		coord.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after install cancellation")
	}
	if coord.Started("ttyd-widget") {
		t.Fatal("canceled install must not start daemon")
	}
	if s, ok := tracker.Get("ttyd-widget"); !ok || s != readiness.StateInstalling {
		t.Errorf("ttyd-widget = (%q, %v), want (installing, true)", s, ok)
	}
}

type instantFailManager struct {
	opkg.Manager
	started chan struct{}
}

func (m *instantFailManager) Install(_ context.Context, _ []string) error {
	select {
	case m.started <- struct{}{}:
	default:
	}

	return errors.New("simulated failure")
}

func TestCoordinatorCancellationSkipsRetrySleep(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd"})

	ctx, cancel := context.WithCancel(context.Background())
	mgr := &instantFailManager{started: make(chan struct{}, 1)}
	coord, _ := newTestCoordinator(t, builtinDir, mgr, &startRecorder{}, []time.Duration{time.Hour})
	coord.PreRegister()
	coord.Run(ctx)
	<-mgr.started
	cancel()

	done := make(chan struct{})
	go func() {
		coord.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after retry sleep cancellation")
	}
}

// hookRecorder records daemon Start and Stop invocations.
type hookRecorder struct {
	mu     sync.Mutex
	starts []string
	stops  []string
}

func (r *hookRecorder) Start(name, _, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.starts = append(r.starts, name)

	return nil
}

func (r *hookRecorder) Stop(name, _, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stops = append(r.stops, name)

	return nil
}

func TestStartupShutdownLifecycle(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltinDaemon(t, builtinDir, "ready-widget", []string{"ttyd"})
	writeBuiltinDaemon(t, builtinDir, "broken-widget", []string{"socat"})
	writeBuiltinDaemon(t, builtinDir, "plain-widget", nil)

	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	reg := registry.New(store, filepath.Join(root, "user-plugins"), builtinDir)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := &stuckManager{failing: map[string]bool{"socat": true}}
	rec := &hookRecorder{}
	tracker := readiness.New()
	coord := newStartupCoordinator(reg, mgr, rec, tracker, nil, logger)

	coord.PreRegister()
	startupActivate(reg, rec, coord.Deferred, logger)

	if got := fmt.Sprint(rec.starts); got != "[plain-widget]" {
		t.Fatalf("immediate starts = %v, want [plain-widget]", rec.starts)
	}

	coord.Run(context.Background())
	coord.Wait()

	if !slices.Contains(rec.starts, "ready-widget") || slices.Contains(rec.starts, "broken-widget") {
		t.Fatalf("post-install starts = %v, want ready-widget started, broken-widget not", rec.starts)
	}

	shutdownDaemons(reg, rec, func(name string) bool {
		return coord.Deferred(name) && !coord.Started(name)
	}, logger)

	slices.Sort(rec.stops)
	if got := fmt.Sprint(rec.stops); got != "[plain-widget ready-widget]" {
		t.Fatalf("stops = %v, want [plain-widget ready-widget] (broken-widget skipped)", rec.stops)
	}
}

type concurrentStopper struct {
	started chan string
	release chan struct{}
}

func (s *concurrentStopper) Stop(name, _, _ string) error {
	s.started <- name
	<-s.release
	return nil
}

func TestShutdownDaemonsStopsConcurrently(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltinDaemon(t, builtinDir, "first-widget", nil)
	writeBuiltinDaemon(t, builtinDir, "second-widget", nil)
	reg := builtinRegistry(t, builtinDir)
	stopper := &concurrentStopper{started: make(chan string, 2), release: make(chan struct{})}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	done := make(chan struct{})
	go func() {
		shutdownDaemons(reg, stopper, nil, logger)
		close(done)
	}()

	seen := make(map[string]bool)
	for range 2 {
		select {
		case name := <-stopper.started:
			seen[name] = true
		case <-time.After(1 * time.Second):
			close(stopper.release)
			<-done
			t.Fatalf("stop hooks did not start concurrently; started %v", seen)
		}
	}
	close(stopper.release)
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("shutdownDaemons did not finish after releasing hooks")
	}
	if !seen["first-widget"] || !seen["second-widget"] {
		t.Fatalf("started hooks = %v, want both plugins", seen)
	}
}

func TestServeReturnsListenerError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := &http.Server{Addr: ln.Addr().String()}

	errCh := make(chan error, 1)
	go func() {
		errCh <- serve(context.Background(), srv, logger, nil)
	}()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("serve returned nil, want listener bind error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return on listener failure")
	}
}

func TestServeShutdownCallbackRunsBeforeReturn(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := &http.Server{Addr: "127.0.0.1:0"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	callbackEntered := make(chan struct{})
	releaseCallback := make(chan struct{})
	var calls atomic.Int32

	errCh := make(chan error, 1)
	go func() {
		errCh <- serve(ctx, srv, logger, func() {
			calls.Add(1)
			close(callbackEntered)
			<-releaseCallback
		})
	}()

	cancel()
	select {
	case <-callbackEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown callback was not called")
	}
	close(releaseCallback)
	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return after callback release")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("shutdown callback calls = %d, want 1", got)
	}
}

type blockingManager struct {
	opkg.Manager
	release chan struct{}
}

func (m *blockingManager) Install(ctx context.Context, _ []string) error {
	select {
	case <-m.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestListServesWhileInstallBlocked(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd"})

	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	reg := registry.New(store, filepath.Join(root, "user-plugins"), builtinDir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	release := make(chan struct{})
	mgr := &blockingManager{release: release}
	tracker := readiness.New()
	rec := &hookRecorder{}
	coord := newStartupCoordinator(reg, mgr, rec, tracker, nil, logger)

	mux := http.NewServeMux()
	mgmt.New(mgmt.Config{
		UserPluginsDir:    filepath.Join(root, "user-plugins"),
		BuiltinPluginsDir: builtinDir,
	}, store, mgr, rec, tracker, reg, logger).Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	coord.PreRegister()
	coord.Run(context.Background())

	fetchStatus := func() string {
		t.Helper()
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get(srv.URL + "/api/mgmt/list")
		if err != nil {
			t.Fatalf("GET /api/mgmt/list while install blocked: %v", err)
		}
		defer resp.Body.Close()
		var body struct {
			Plugins []struct {
				Name       string `json:"name"`
				DepsStatus string `json:"depsStatus"`
			} `json:"plugins"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode list: %v", err)
		}
		for _, p := range body.Plugins {
			if p.Name == "ttyd-widget" {
				return p.DepsStatus
			}
		}
		t.Fatal("ttyd-widget missing from list")

		return ""
	}

	if got := fetchStatus(); got != "installing" {
		t.Fatalf("depsStatus while install blocked = %q, want installing", got)
	}
	close(release)
	coord.Wait()

	if got := fetchStatus(); got != "ready" {
		t.Fatalf("depsStatus after install = %q, want ready", got)
	}
}
