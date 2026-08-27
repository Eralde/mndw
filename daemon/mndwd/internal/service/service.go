// Package service manages Entware init.d scripts.
package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultInitDir      = "/opt/etc/init.d"
	defaultMndwdPidfile = "/opt/var/run/mndwd.pid"
	defaultProbeTimeout = 3 * time.Second
	defaultStatusCap    = 4
	pidFileReadLimit    = 64
)

var serviceNameRe = regexp.MustCompile(`^[SK][0-9]{2}[A-Za-z0-9._-]+$`)

var ErrServiceUnavailable = errors.New("service manager unavailable")

type ServiceEntry struct {
	Name            string `json:"name"`
	Label           string `json:"label"`
	State           string `json:"state"`
	EnabledAtBoot   bool   `json:"enabledAtBoot"`
	Pid             int    `json:"pid,omitempty"`
	AutostartPinned bool   `json:"autostartPinned"`
	Protected       bool   `json:"protected"`
}

type Manager interface {
	List(context.Context) ([]ServiceEntry, error)
	Status(context.Context, string) (ServiceEntry, error)
	Start(context.Context, string) (ServiceEntry, error)
	Stop(context.Context, string) (ServiceEntry, error)
	Restart(context.Context, string) (ServiceEntry, error)
	SetEnabled(context.Context, string, bool) (ServiceEntry, error)
}

type InvalidServiceError struct{ Name string }

func (e *InvalidServiceError) Error() string { return "invalid service name: " + e.Name }

type ProtectedServiceError struct{ Name string }

func (e *ProtectedServiceError) Error() string { return "protected service: " + e.Name }

type EnabledPinnedError struct{ Name string }

func (e *EnabledPinnedError) Error() string {
	return "autostart is pinned by ENABLED= in script: " + e.Name
}

type ActionFailedError struct {
	Action   string
	Expected string
	Actual   string
}

func (e *ActionFailedError) Error() string {
	return fmt.Sprintf("service %s failed verification: expected %s, got %s", e.Action, e.Expected, e.Actual)
}

type ActionTimeoutError struct {
	Action string
	Err    error
}

func (e *ActionTimeoutError) Error() string { return "service action timed out: " + e.Action }
func (e *ActionTimeoutError) Unwrap() error { return e.Err }

type execManager struct {
	logger       *slog.Logger
	runner       func(context.Context, ...string) (string, int, error)
	initDir      string
	pidfile      string
	procSnapshot func(context.Context) ([]procRecord, error)
	procRoot     string
	pidFileDirs  []string
	probeTimeout time.Duration
	statusCap    int
	clock        func() time.Time
	gate         chan struct{}
	statusGate   chan struct{}
	defaultsMu   sync.Mutex
	gateMu       sync.Mutex
	statusGateMu sync.Mutex
}

func New(mode string, logger *slog.Logger) Manager {
	if logger == nil {
		logger = slog.Default()
	}

	if mode == "stub" {
		return newStub(logger)
	}

	return &execManager{
		logger:       logger,
		initDir:      defaultInitDir,
		pidfile:      defaultMndwdPidfile,
		probeTimeout: defaultProbeTimeout,
		statusCap:    defaultStatusCap,
		clock:        time.Now,
		gate:         make(chan struct{}, 1),
		statusGate:   make(chan struct{}, defaultStatusCap),
	}
}

func (m *execManager) defaults() {
	m.defaultsMu.Lock()

	defer m.defaultsMu.Unlock()

	if m.logger == nil {
		m.logger = slog.Default()
	}

	if m.runner == nil {
		m.runner = execRun
	}

	if m.initDir == "" {
		m.initDir = defaultInitDir
	}

	if m.pidfile == "" {
		m.pidfile = defaultMndwdPidfile
	}

	if m.procRoot == "" {
		m.procRoot = "/proc"
	}

	if m.pidFileDirs == nil {
		m.pidFileDirs = []string{"/tmp", "/var/run", "/opt/var/run"}
	}

	if m.procSnapshot == nil {
		m.procSnapshot = func(ctx context.Context) ([]procRecord, error) {
			return readProcSnapshot(ctx, m.procRoot)
		}
	}

	if m.probeTimeout <= 0 {
		m.probeTimeout = defaultProbeTimeout
	}

	if m.statusCap <= 0 {
		m.statusCap = defaultStatusCap
	}

	if m.clock == nil {
		m.clock = time.Now
	}

	m.gateMu.Lock()

	if m.gate == nil {
		m.gate = make(chan struct{}, 1)
	}

	m.gateMu.Unlock()
	m.statusGateMu.Lock()

	if m.statusGate == nil {
		m.statusGate = make(chan struct{}, m.statusCap)
	}

	m.statusGateMu.Unlock()
}

func (m *execManager) List(ctx context.Context) ([]ServiceEntry, error) {
	m.defaults()

	services, err := m.scanServices(ctx)
	if err != nil {
		return nil, err
	}

	m.enrichLiveness(ctx, services)

	return services, nil
}

// scanServices lists init.d services from the directory alone, without probing:
// every entry comes back as "unknown" with no PID. It is the cheap path used by
// resolve() on every action; List() layers a best-effort liveness pass on top.
func (m *execManager) scanServices(ctx context.Context) ([]ServiceEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(m.initDir)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrServiceUnavailable, err)
	}

	services := make([]ServiceEntry, 0, len(entries))

	for _, entry := range entries {
		if !serviceNameRe.MatchString(entry.Name()) {
			continue
		}

		path := filepath.Join(m.initDir, entry.Name())
		info, infoErr := os.Stat(path)

		if infoErr != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
			continue
		}

		enabled := entry.Name()[0] == 'S'
		meta := m.readScriptMeta(path)
		pinned := meta.enabled != nil

		if pinned {
			enabled = *meta.enabled
		}

		services = append(services, makeEntryWithAutostart(entry.Name(), "unknown", enabled, pinned))
	}

	sort.Slice(services, func(i, j int) bool { return services[i].Name < services[j].Name })

	return services, nil
}

// enrichLiveness fills in best-effort State/Pid for the whole list from a single
// /proc snapshot, without running any per-script status verb. A matched process
// marks the service "running" with its PID; a non-match is left "unknown" (we
// cannot distinguish stopped from unknown without the script). This is a fast
// approximation the caller's later Status() probe refines to the authoritative
// answer, so any snapshot failure is silently skipped rather than fatal.
func (m *execManager) enrichLiveness(ctx context.Context, services []ServiceEntry) {
	if len(services) == 0 {
		return
	}

	records, err := m.procSnapshot(ctx)
	if err != nil {
		return
	}

	for i := range services {
		name := services[i].Name
		meta := m.readScriptMeta(filepath.Join(m.initDir, name))

		if pid := resolveFromRecords(records, name, meta, m.pidFileDirs, m.pidfile); pid != 0 {
			services[i].State = "running"
			services[i].Pid = pid
		}
	}
}

func makeEntry(name, state string) ServiceEntry {
	return makeEntryEnabled(name, state, name[0] == 'S')
}

func makeEntryEnabled(name, state string, enabled bool) ServiceEntry {
	return makeEntryWithAutostart(name, state, enabled, false)
}

func makeEntryWithAutostart(name, state string, enabled, pinned bool) ServiceEntry {
	return ServiceEntry{
		Name:            name,
		Label:           name[3:],
		State:           state,
		EnabledAtBoot:   enabled,
		AutostartPinned: pinned,
		Protected:       name == "S70mndwd" || name == "S80lighttpd",
	}
}

func (m *execManager) resolve(ctx context.Context, name string) (ServiceEntry, string, error) {
	if !serviceNameRe.MatchString(name) {
		return ServiceEntry{}, "", &InvalidServiceError{Name: name}
	}

	entries, err := m.scanServices(ctx)
	if err != nil {
		return ServiceEntry{}, "", err
	}

	for _, entry := range entries {
		if entry.Name == name {
			return entry, filepath.Join(m.initDir, name), nil
		}
	}

	return ServiceEntry{}, "", &InvalidServiceError{Name: name}
}

func (m *execManager) Status(ctx context.Context, name string) (ServiceEntry, error) {
	m.defaults()

	entry, path, err := m.resolve(ctx, name)
	if err != nil {
		return entry, err
	}

	probeCtx, cancel := context.WithTimeout(ctx, m.probeTimeout)

	defer cancel()

	if err := acquire(probeCtx, m.statusGate); err != nil {
		if ctx.Err() != nil {
			return entry, ctx.Err()
		}

		entry.State = "unknown"

		return entry, nil
	}

	defer release(m.statusGate)

	state, pid, probeErr := m.probe(probeCtx, entry.Name, path)

	if probeErr != nil {
		if ctx.Err() != nil {
			return entry, ctx.Err()
		}

		entry.State = "unknown"

		return entry, nil
	}

	entry.State = state
	entry.Pid = pid

	return entry, nil
}

func (m *execManager) Start(ctx context.Context, name string) (ServiceEntry, error) {
	return m.mutate(ctx, name, "start", "running")
}

func (m *execManager) Stop(ctx context.Context, name string) (ServiceEntry, error) {
	return m.mutate(ctx, name, "stop", "stopped")
}

func (m *execManager) Restart(ctx context.Context, name string) (ServiceEntry, error) {
	return m.mutate(ctx, name, "restart", "running")
}

func (m *execManager) SetEnabled(ctx context.Context, name string, enable bool) (ServiceEntry, error) {
	m.defaults()

	entry, path, err := m.resolve(ctx, name)
	if err != nil {
		return entry, err
	}

	if entry.Protected {
		return entry, &ProtectedServiceError{Name: name}
	}

	if meta := m.readScriptMeta(path); meta.enabled != nil {
		return entry, &EnabledPinnedError{Name: name}
	}

	if entry.EnabledAtBoot == enable {
		return entry, nil
	}

	if err := acquire(ctx, m.gate); err != nil {
		return entry, m.actionContextError("set-enabled", err)
	}

	defer release(m.gate)

	prefix := byte('K')

	if enable {
		prefix = 'S'
	}

	newName := string(prefix) + name[1:]
	newPath := filepath.Join(m.initDir, newName)

	if _, statErr := os.Stat(newPath); statErr == nil {
		return entry, &ActionFailedError{Action: "set-enabled", Expected: newName, Actual: "target name already exists"}
	}

	if renameErr := os.Rename(path, newPath); renameErr != nil {
		return entry, &ActionFailedError{Action: "set-enabled", Expected: newName, Actual: renameErr.Error()}
	}

	if m.logger != nil {
		m.logger.Info("service autostart changed", "event", "service_autostart_changed", "service", name, "renamed_to", newName, "enabled", enable, "at", m.clock())
	}

	return makeEntryEnabled(newName, entry.State, enable), nil
}

func (m *execManager) mutate(ctx context.Context, name, action, expected string) (ServiceEntry, error) {
	m.defaults()

	entry, path, err := m.resolve(ctx, name)
	if err != nil {
		return entry, err
	}

	if (action == "stop" || action == "restart") && entry.Protected {
		return entry, &ProtectedServiceError{Name: name}
	}

	if err := acquire(ctx, m.gate); err != nil {
		return entry, m.actionContextError(action, err)
	}

	defer release(m.gate)

	previous, _, probeErr := m.probeWithBudget(ctx, entry.Name, path)

	if probeErr != nil {
		return entry, m.actionContextError(action, probeErr)
	}

	_, exitCode, runErr := m.runner(ctx, path, action)

	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) {
			return entry, &ActionTimeoutError{Action: action, Err: runErr}
		}

		if errors.Is(runErr, context.Canceled) {
			return entry, runErr
		}

		return entry, &ActionFailedError{Action: action, Expected: expected, Actual: runErr.Error()}
	}

	if exitCode != 0 {
		return entry, &ActionFailedError{Action: action, Expected: expected, Actual: fmt.Sprintf("exit %d", exitCode)}
	}

	var pid int
	entry.State, pid, probeErr = m.probeWithBudget(ctx, entry.Name, path)

	if probeErr != nil {
		return entry, m.actionContextError(action, probeErr)
	}

	entry.Pid = pid

	if entry.State == "unknown" {
		return entry, nil
	}

	if entry.State != expected {
		return entry, &ActionFailedError{Action: action, Expected: expected, Actual: entry.State}
	}

	if meaningful(previous) && meaningful(entry.State) && previous != entry.State && m.logger != nil {
		m.logger.Info("service state changed", "event", "service_state_changed", "service", name, "previous", previous, "current", entry.State, "at", m.clock())
	}

	return entry, nil
}

func (m *execManager) actionContextError(action string, err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &ActionTimeoutError{Action: action, Err: err}
	}

	return err
}

func (m *execManager) probeWithBudget(ctx context.Context, name, path string) (string, int, error) {
	probeCtx, cancel := context.WithTimeout(ctx, m.probeTimeout)

	defer cancel()

	state, pid, err := m.probe(probeCtx, name, path)
	if err != nil {
		if ctx.Err() != nil {
			return "unknown", 0, ctx.Err()
		}

		if errors.Is(err, context.DeadlineExceeded) {
			return "unknown", 0, nil
		}

		return "unknown", 0, nil
	}

	return state, pid, nil
}

func (m *execManager) probe(ctx context.Context, name, path string) (string, int, error) {
	for _, verb := range []string{"status", "check"} {
		out, exitCode, err := m.runner(ctx, path, verb)
		if err != nil {
			if ctx.Err() != nil {
				return "unknown", 0, ctx.Err()
			}

			continue
		}

		if exitCode == 0 {
			pid, resolveErr := m.resolvePID(ctx, name, path)

			if resolveErr != nil {
				if ctx.Err() != nil {
					return "unknown", 0, ctx.Err()
				}

				return "running", 0, nil
			}

			return "running", pid, nil
		}

		if isUnknownVerb(out) {
			continue
		}

		if exitCode == 1 {
			return "stopped", 0, nil
		}

		return "unknown", 0, nil
	}

	state, pid, livenessErr := m.probeLiveness(ctx, name, path)

	if livenessErr != nil {
		if ctx.Err() != nil {
			return "unknown", 0, ctx.Err()
		}

		return "unknown", 0, nil
	}

	return state, pid, nil
}

func (m *execManager) probeLiveness(ctx context.Context, name, path string) (string, int, error) {
	pid, err := m.resolvePID(ctx, name, path)

	if err != nil {
		if ctx.Err() != nil {
			return "unknown", 0, ctx.Err()
		}

		return "unknown", 0, nil
	}

	if pid != 0 {
		return "running", pid, nil
	}

	return "unknown", 0, nil
}

func readPidFile(path string) (int, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}

	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}

	defer f.Close()

	return parsePidFile(f)
}

func parsePidFile(r io.Reader) (int, bool) {
	data, err := io.ReadAll(io.LimitReader(r, pidFileReadLimit+1))
	if err != nil || len(data) > pidFileReadLimit {
		return 0, false
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, false
	}

	return pid, true
}

func (m *execManager) readScriptMeta(path string) scriptMeta {
	f, err := os.Open(path)
	if err != nil {
		return scriptMeta{}
	}

	defer f.Close()

	return parseScriptMeta(f)
}

func isUnknownVerb(out string) bool {
	value := strings.ToLower(out)

	for _, marker := range []string{"usage:", "unknown command", "unknown option", "unrecognized option", "not a valid command"} {
		if strings.Contains(value, marker) {
			return true
		}
	}

	return false
}

func meaningful(state string) bool { return state == "running" || state == "stopped" }

func acquire(ctx context.Context, gate chan struct{}) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func release(gate chan struct{}) { <-gate }

func execRun(ctx context.Context, args ...string) (string, int, error) {
	if len(args) == 0 {
		return "", 0, errors.New("service command is missing")
	}

	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	if ctx.Err() != nil {
		return "", 0, ctx.Err()
	}

	if err == nil {
		return stdout.String(), 0, nil
	}

	var exitErr *exec.ExitError

	if errors.As(err, &exitErr) {
		return stdout.String() + stderr.String(), exitErr.ExitCode(), nil
	}

	return "", 0, err
}

type stubManager struct {
	logger   *slog.Logger
	mu       sync.Mutex
	services map[string]ServiceEntry
}

func newStub(logger *slog.Logger) *stubManager {
	return &stubManager{
		logger: logger,
		services: map[string]ServiceEntry{
			"S70mndwd":        makeEntry("S70mndwd", "running"),
			"S80lighttpd":     makeEntry("S80lighttpd", "running"),
			"S95pinned":       makeEntryWithAutostart("S95pinned", "stopped", false, true),
			"S99transmission": makeEntry("S99transmission", "stopped"),
			"K50dropbear":     makeEntry("K50dropbear", "stopped"),
		},
	}
}

func (m *stubManager) List(ctx context.Context) ([]ServiceEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	out := make([]ServiceEntry, 0, len(m.services))

	for _, entry := range m.services {
		out = append(out, entry)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	return out, nil
}

func (m *stubManager) Status(ctx context.Context, name string) (ServiceEntry, error) {
	if err := ctx.Err(); err != nil {
		return ServiceEntry{}, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	entry, ok := m.services[name]

	if !ok {
		return ServiceEntry{}, &InvalidServiceError{Name: name}
	}

	return entry, nil
}

func (m *stubManager) Start(ctx context.Context, name string) (ServiceEntry, error) {
	return m.mutate(ctx, name, "start", "running")
}

func (m *stubManager) Stop(ctx context.Context, name string) (ServiceEntry, error) {
	return m.mutate(ctx, name, "stop", "stopped")
}

func (m *stubManager) Restart(ctx context.Context, name string) (ServiceEntry, error) {
	return m.mutate(ctx, name, "restart", "running")
}

func (m *stubManager) SetEnabled(ctx context.Context, name string, enable bool) (ServiceEntry, error) {
	if err := ctx.Err(); err != nil {
		return ServiceEntry{}, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	entry, ok := m.services[name]

	if !ok {
		return ServiceEntry{}, &InvalidServiceError{Name: name}
	}

	if entry.Protected {
		return entry, &ProtectedServiceError{Name: name}
	}

	if entry.AutostartPinned {
		return entry, &EnabledPinnedError{Name: name}
	}

	if entry.EnabledAtBoot == enable {
		return entry, nil
	}

	prefix := byte('K')

	if enable {
		prefix = 'S'
	}

	newName := string(prefix) + name[1:]
	updated := makeEntryEnabled(newName, entry.State, enable)

	delete(m.services, name)

	m.services[newName] = updated

	return updated, nil
}

func (m *stubManager) mutate(ctx context.Context, name, action, state string) (ServiceEntry, error) {
	if err := ctx.Err(); err != nil {
		return ServiceEntry{}, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	entry, ok := m.services[name]

	if !ok {
		return ServiceEntry{}, &InvalidServiceError{Name: name}
	}

	if (action == "stop" || action == "restart") && entry.Protected {
		return entry, &ProtectedServiceError{Name: name}
	}

	previous := entry.State
	entry.State = state
	m.services[name] = entry

	if m.logger != nil && meaningful(previous) && meaningful(state) && previous != state {
		m.logger.Info("service state changed (stub)", "event", "service_state_changed", "service", name)
	}

	return entry, nil
}
