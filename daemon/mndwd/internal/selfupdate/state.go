package selfupdate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Operation string

const (
	OperationUpdate Operation = "update"
	OperationRevert Operation = "revert"
)

type State string

const (
	StateIdle       State = "idle"
	StateInProgress State = "in-progress"
	StateFailed     State = "failed"
)

type Intent struct {
	Operation      Operation `json:"operation"`
	CurrentVersion string    `json:"currentVersion"`
	TargetVersion  string    `json:"targetVersion"`
	StartedAt      time.Time `json:"startedAt"`
}

type Status struct {
	State           State     `json:"state"`
	Operation       Operation `json:"operation,omitempty"`
	Version         string    `json:"version"`
	TargetVersion   string    `json:"targetVersion,omitempty"`
	FailureCode     string    `json:"failureCode,omitempty"`
	RollbackVersion string    `json:"rollbackVersion,omitempty"`
}

type Completion struct {
	Operation       Operation `json:"operation"`
	PreviousVersion string    `json:"previousVersion"`
	TargetVersion   string    `json:"targetVersion"`
}

var (
	ErrNoIntent = errors.New("self-update intent not found")
	versionRe   = regexp.MustCompile(`^[A-Za-z0-9.+~:-]+$`)
)

type StateStore struct {
	root string
}

func NewStateStore(root string) *StateStore { return &StateStore{root: root} }

func (s *StateStore) intentPath() string          { return filepath.Join(s.root, "self-update.json") }
func (s *StateStore) failurePath() string         { return filepath.Join(s.root, "self-update.failure") }
func (s *StateStore) completionPath() string      { return filepath.Join(s.root, "self-update.completed") }
func (s *StateStore) rollbackDir() string         { return filepath.Join(s.root, "rollback") }
func (s *StateStore) rollbackVersionPath() string { return filepath.Join(s.rollbackDir(), "version") }

func validVersion(version string) bool { return versionRe.MatchString(version) }

func validIntent(intent Intent) error {
	if intent.Operation != OperationUpdate && intent.Operation != OperationRevert {
		return fmt.Errorf("invalid operation %q", intent.Operation)
	}

	if !validVersion(intent.CurrentVersion) || !validVersion(intent.TargetVersion) {
		return errors.New("invalid self-update version")
	}

	return nil
}

func (s *StateStore) WriteIntent(intent Intent) error {
	if err := validIntent(intent); err != nil {
		return err
	}

	if intent.StartedAt.IsZero() {
		intent.StartedAt = time.Now().UTC()
	}

	data, err := json.Marshal(intent)
	if err != nil {
		return fmt.Errorf("encode self-update intent: %w", err)
	}

	return atomicWrite(s.intentPath(), data, 0o644)
}

func (s *StateStore) ReadIntent() (Intent, error) {
	data, err := os.ReadFile(s.intentPath())
	if errors.Is(err, os.ErrNotExist) {
		return Intent{}, ErrNoIntent
	}

	if err != nil {
		return Intent{}, fmt.Errorf("read self-update intent: %w", err)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))

	decoder.DisallowUnknownFields()

	var intent Intent

	if err := decoder.Decode(&intent); err != nil {
		return Intent{}, fmt.Errorf("decode self-update intent: %w", err)
	}

	var extra any

	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return Intent{}, errors.New("trailing self-update intent data")
		}

		return Intent{}, fmt.Errorf("decode trailing self-update intent data: %w", err)
	}

	if err := validIntent(intent); err != nil {
		return Intent{}, err
	}

	return intent, nil
}

func (s *StateStore) ClearIntent() error {
	if err := os.Remove(s.intentPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear self-update intent: %w", err)
	}

	return nil
}

func (s *StateStore) ClearFailure() error {
	if err := os.Remove(s.failurePath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear self-update failure: %w", err)
	}

	return nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	temp, err := os.CreateTemp(filepath.Dir(path), ".self-update-*")
	if err != nil {
		return err
	}

	tempPath := temp.Name()
	keep := false

	defer func() {
		if !keep {
			_ = os.Remove(tempPath)
		}
	}()

	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()

		return err
	}

	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()

		return err
	}

	if err := temp.Sync(); err != nil {
		_ = temp.Close()

		return err
	}

	if err := temp.Close(); err != nil {
		return err
	}

	if err := os.Rename(tempPath, path); err != nil {
		return err
	}

	keep = true

	return nil
}

func (s *StateStore) readFailure() string {
	data, err := os.ReadFile(s.failurePath())
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(data))
}

func (s *StateStore) RollbackVersion(runningVersion string) string {
	pointerInfo, err := os.Lstat(s.rollbackVersionPath())
	if err != nil || !pointerInfo.Mode().IsRegular() {
		return ""
	}

	versionData, err := os.ReadFile(s.rollbackVersionPath())
	if err != nil {
		return ""
	}

	version := strings.TrimSpace(string(versionData))

	if !validVersion(version) || version == runningVersion {
		return ""
	}

	path := filepath.Join(s.rollbackDir(), "mndw-"+version+".ipk")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}

	return version
}

func (s *StateStore) RollbackPath(runningVersion string) (string, bool) {
	version := s.RollbackVersion(runningVersion)

	if version == "" {
		return "", false
	}

	return filepath.Join(s.rollbackDir(), "mndw-"+version+".ipk"), true
}

func (s *StateStore) Status(runningVersion string, lockHeld bool) Status {
	status := Status{State: StateIdle, Version: runningVersion, RollbackVersion: s.RollbackVersion(runningVersion)}
	intent, err := s.ReadIntent()
	if errors.Is(err, ErrNoIntent) {
		return status
	}

	if err != nil {
		status.State = StateFailed
		status.FailureCode = "state-corrupt"

		return status
	}

	status.Operation = intent.Operation
	status.TargetVersion = intent.TargetVersion

	if runningVersion == intent.TargetVersion {
		_ = s.writeCompletion(Completion{
			Operation:       intent.Operation,
			PreviousVersion: intent.CurrentVersion,
			TargetVersion:   intent.TargetVersion,
		})
		_ = s.ClearIntent()
		_ = s.ClearFailure()
		status.State = StateIdle
		status.RollbackVersion = s.RollbackVersion(runningVersion)

		return status
	}

	if failure := s.readFailure(); failure != "" {
		status.State = StateFailed
		status.FailureCode = failure

		return status
	}

	if lockHeld {
		status.State = StateInProgress

		return status
	}

	status.State = StateFailed

	if runningVersion != intent.CurrentVersion {
		status.FailureCode = "unexpected-version"
	} else {
		status.FailureCode = "helper-exited"
	}

	return status
}

func (s *StateStore) writeCompletion(completion Completion) error {
	if completion.Operation != OperationUpdate && completion.Operation != OperationRevert {
		return errors.New("invalid self-update completion operation")
	}
	if !validVersion(completion.PreviousVersion) || !validVersion(completion.TargetVersion) {
		return errors.New("invalid self-update completion version")
	}
	data, err := json.Marshal(completion)
	if err != nil {
		return err
	}

	return atomicWrite(s.completionPath(), data, 0o644)
}

func (s *StateStore) ConsumeCompletion() (Completion, error) {
	data, err := os.ReadFile(s.completionPath())
	if errors.Is(err, os.ErrNotExist) {
		return Completion{}, ErrNoIntent
	}
	if err != nil {
		return Completion{}, err
	}

	var completion Completion
	if err := json.Unmarshal(data, &completion); err != nil {
		return Completion{}, err
	}
	if err := os.Remove(s.completionPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Completion{}, err
	}

	return completion, nil
}
