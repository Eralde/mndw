package backend

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// processExit broadcasts one command.Wait result to every lifecycle observer.
// Closing done synchronizes publication of err with all waiters.
type processExit struct {
	done chan struct{}
	err  error
}

func newProcessExit() *processExit {
	return &processExit{done: make(chan struct{})}
}

func (p *processExit) wait() error {
	<-p.done

	return p.err
}

type ProcessIdentity struct {
	PID            int
	PGID           int
	StartTimeTicks uint64
	ExecutablePath string
	ExecutableDev  uint64
	ExecutableIno  uint64
}

type ProcessReader interface {
	BootID() (string, error)
	ProcessIdentity(pid int) (ProcessIdentity, error)
}

type systemProcessReader struct{}

func (systemProcessReader) BootID() (string, error) { return readBootID() }

func (systemProcessReader) ProcessIdentity(pid int) (ProcessIdentity, error) {
	return ReadProcessIdentity(pid)
}

func ValidateServiceLease(lease ServiceLease, reader ProcessReader) (bool, error) {
	if lease.BootID == "" || lease.PID <= 0 || lease.PGID <= 0 || lease.StartTimeTicks == 0 || lease.ExecutablePath == "" {
		return false, fmt.Errorf("lease is incomplete")
	}

	bootID, err := reader.BootID()
	if err != nil {
		return false, fmt.Errorf("read boot ID: %w", err)
	}

	if bootID != lease.BootID {
		return false, nil
	}

	identity, err := reader.ProcessIdentity(lease.PID)
	if err != nil {
		return false, nil
	}

	if identity.PID != lease.PID || identity.PGID != lease.PGID || identity.StartTimeTicks != lease.StartTimeTicks || identity.ExecutablePath != lease.ExecutablePath || identity.ExecutableDev != lease.ExecutableDev || identity.ExecutableIno != lease.ExecutableIno {
		return false, nil
	}

	return true, nil
}

func ownProcessID() int { return os.Getpid() }

func (s *Supervisor) prepareStart(paths RuntimePaths, spec ServiceSpec) (ValidatedCommand, error) {
	if err := paths.Ensure(); err != nil {
		return ValidatedCommand{}, err
	}

	if err := recoverStaleRuntime(paths, s.cfg.FinalReapTimeout); err != nil && s.cfg.Logger != nil {
		s.cfg.Logger.Warn("stale service recovery failed", "plugin", spec.PluginID, "error", err)
	}

	if err := removeRuntimeEvidence(paths); err != nil {
		return ValidatedCommand{}, err
	}

	if spec.Builtin && s.cfg.AllowSymlinkedBuiltinRoot {
		return validateBuiltinCommand(spec.Dir, spec.Command)
	}

	return ValidateCommand(spec.Dir, spec.Command)
}

func (s *Supervisor) launchService(spec ServiceSpec, paths RuntimePaths, validated ValidatedCommand) (*exec.Cmd, *StderrRing, error) {
	command := exec.Command(validated.Path, spec.Args...)

	configureExecCommand(command)

	command.Dir = spec.Dir
	command.Env = BuildChildEnvironment(EnvironmentSpec{
		Path:             os.Getenv("PATH"),
		PluginID:         spec.PluginID,
		PluginDir:        spec.Dir,
		PluginDataDir:    serviceDataDir(s.cfg.PluginDataRoot, spec),
		PluginRuntimeDir: paths.PluginDir,
		BackendSocket:    paths.BackendSocket,
		ProtocolVersion:  spec.ProtocolVersion,
		RCISessionSocket: spec.RCISessionSocket,
		Service:          true,
	})
	stderr := NewStderrRing(4<<10, 64)
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return nil, nil, err
	}

	return command, stderr, nil
}

func (s *Supervisor) reapUnregisteredProcess(command *exec.Cmd, done *processExit) {
	_ = terminateExecProcess(command.Process)

	if waitForProcessExit(done.done, s.cfg.StopTimeout) {
		return
	}

	_ = killExecProcess(command.Process)
	_ = waitForProcessExit(done.done, s.cfg.FinalReapTimeout)
}

func serviceDataDir(root string, spec ServiceSpec) string {
	if root == "" {
		return spec.Dir
	}

	path := filepath.Join(root, spec.PluginID)

	if err := os.MkdirAll(path, 0o700); err == nil {
		_ = os.Chmod(path, 0o700)
	}

	return path
}

func waitForProcessExit(done <-chan struct{}, timeout time.Duration) bool {
	if timeout <= 0 {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}

	timer := time.NewTimer(timeout)

	defer timer.Stop()

	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func removeRuntimeEvidence(paths RuntimePaths) error {
	// The persistent-RCI listener is a daemon-owned facility and intentionally
	// outlives child start, crash, and restart. Its reconciler owns this socket.
	for _, path := range []string{paths.BackendSocket, paths.ServiceLease} {
		if err := removeIfExists(path); err != nil {
			return err
		}
	}

	return nil
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	return nil
}

func recoverStaleRuntime(paths RuntimePaths, timeout time.Duration) error {
	lease, err := ReadServiceLease(paths.ServiceLease)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil {
		_ = removeIfExists(paths.ServiceLease)

		return err
	}

	matched, err := ValidateServiceLease(lease, systemProcessReader{})
	if err != nil {
		_ = removeRuntimeEvidence(paths)

		return err
	}

	if !matched {
		return removeRuntimeEvidence(paths)
	}

	if err := terminateExecGroup(lease.PGID); err != nil {
		return err
	}

	reapProcessGroup(lease.PGID, timeout)

	return removeRuntimeEvidence(paths)
}

// reapProcessGroup waits up to timeout for the process group to exit, polling
// every 10ms and escalating to SIGKILL once the deadline elapses. A timeout of
// zero or less skips the wait entirely. It does not remove runtime evidence;
// the caller owns that cleanup.
func reapProcessGroup(pgid int, timeout time.Duration) {
	if timeout <= 0 {
		return
	}

	deadline := time.NewTimer(timeout)

	defer deadline.Stop()

	ticker := time.NewTicker(10 * time.Millisecond)

	defer ticker.Stop()

	for processGroupAlive(pgid) {
		select {
		case <-deadline.C:
			_ = killExecGroup(pgid)

			return
		case <-ticker.C:
		}
	}
}

func writeProcessLease(path string, pid int) error {
	reader := systemProcessReader{}
	bootID, err := reader.BootID()
	if err != nil || bootID == "" {
		return err
	}

	identity, err := reader.ProcessIdentity(pid)
	if err != nil {
		return err
	}

	return WriteServiceLease(path, ServiceLease{
		BootID:         bootID,
		PID:            identity.PID,
		PGID:           identity.PGID,
		StartTimeTicks: identity.StartTimeTicks,
		ExecutablePath: identity.ExecutablePath,
		ExecutableDev:  identity.ExecutableDev,
		ExecutableIno:  identity.ExecutableIno,
	})
}
