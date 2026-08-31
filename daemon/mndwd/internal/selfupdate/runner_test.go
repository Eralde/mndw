package selfupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"mndwd/internal/opkg"
)

type fakeLease struct {
	file      *os.File
	committed bool
	aborted   bool
}

func (l *fakeLease) File() *os.File { return l.file }

func (l *fakeLease) CommitHandoff() error {
	l.committed = true

	return l.file.Close()
}

func (l *fakeLease) Abort() error {
	l.aborted = true

	return l.file.Close()
}

type fakePackageManager struct {
	candidate    opkg.SelfUpdateCandidate
	lease        *fakeLease
	prepareError error
	checkError   error
	locked       bool
	checkCalls   int
}

func (m *fakePackageManager) CheckSelfUpdate(context.Context) (opkg.SelfUpdateCandidate, error) {
	m.checkCalls++

	return m.candidate, m.checkError
}

func (m *fakePackageManager) PrepareSelfUpdate(context.Context) (opkg.SelfUpdateCandidate, opkg.LeaseHandle, error) {
	if m.prepareError != nil {
		return opkg.SelfUpdateCandidate{}, nil, m.prepareError
	}

	return m.candidate, m.lease, nil
}

func (m *fakePackageManager) LockForSelfUpdate(context.Context) (opkg.LeaseHandle, error) {
	return m.lease, nil
}

func (m *fakePackageManager) SelfUpdateLocked() (bool, error) { return m.locked, nil }

func newFakeLease(t *testing.T) *fakeLease {
	t.Helper()

	file, err := os.CreateTemp(t.TempDir(), "lease-")
	if err != nil {
		t.Fatal(err)
	}

	return &fakeLease{file: file}
}

func newTestService(t *testing.T, manager *fakePackageManager) *service {
	t.Helper()

	root := t.TempDir()
	helper := filepath.Join(root, "packaged-helper.sh")

	if err := os.WriteFile(helper, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	return &service{
		manager:        manager,
		store:          NewStateStore(filepath.Join(root, "state")),
		stateDir:       filepath.Join(root, "state"),
		packagedHelper: helper,
		runningVersion: "0.0.3",
	}
}

func TestBeginUpdateUsesPreparedServerCandidate(t *testing.T) {
	root := t.TempDir()
	ipk := filepath.Join(root, "pending", "mndw-0.0.4.ipk")

	if err := os.MkdirAll(filepath.Dir(ipk), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(ipk, []byte("ipk"), 0o644); err != nil {
		t.Fatal(err)
	}

	lease := newFakeLease(t)
	manager := &fakePackageManager{
		candidate: opkg.SelfUpdateCandidate{CurrentVersion: "0.0.3", TargetVersion: "0.0.4", PackagePath: ipk},
		lease:     lease,
	}
	service := newTestService(t, manager)
	service.startProcess = func(_ string, args []string, _ *os.File) error {
		want := []string{"update", "0.0.3", "0.0.4", ipk}

		if !reflect.DeepEqual(args, want) {
			t.Fatalf("helper args = %v, want %v", args, want)
		}

		return nil
	}

	accepted, err := service.BeginUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if accepted.Operation != OperationUpdate || accepted.TargetVersion != "0.0.4" {
		t.Fatalf("accepted = %+v", accepted)
	}

	if !lease.committed || lease.aborted {
		t.Fatalf("lease committed=%v aborted=%v", lease.committed, lease.aborted)
	}

	if _, err := os.Stat(service.helperPath()); err != nil {
		t.Fatalf("helper copy: %v", err)
	}

	intent, err := service.store.ReadIntent()
	if err != nil || intent.TargetVersion != "0.0.4" {
		t.Fatalf("intent=%+v err=%v", intent, err)
	}
}

func TestBeginUpdateUsesPreparationCandidateAfterCheckDiverges(t *testing.T) {
	lease := newFakeLease(t)
	root := t.TempDir()
	ipk := filepath.Join(root, "mndw-0.0.5.ipk")

	if err := os.WriteFile(ipk, []byte("ipk"), 0o644); err != nil {
		t.Fatal(err)
	}

	manager := &fakePackageManager{
		candidate: opkg.SelfUpdateCandidate{CurrentVersion: "0.0.3", TargetVersion: "0.0.5", PackagePath: ipk},
		lease:     lease,
	}
	service := newTestService(t, manager)
	service.startProcess = func(_ string, args []string, _ *os.File) error {
		if args[2] != "0.0.5" || args[3] != ipk {
			t.Fatalf("args = %v", args)
		}

		return nil
	}
	manager.candidate.TargetVersion = "0.0.4"

	if _, err := service.Check(context.Background()); err != nil {
		t.Fatal(err)
	}

	manager.candidate.TargetVersion = "0.0.5"
	accepted, err := service.BeginUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if accepted.TargetVersion != "0.0.5" {
		t.Fatalf("accepted = %+v", accepted)
	}
}

func TestBeginRevertUsesValidatedRollbackPath(t *testing.T) {
	lease := newFakeLease(t)
	manager := &fakePackageManager{lease: lease}
	service := newTestService(t, manager)
	rollbackPath := filepath.Join(service.stateDir, "rollback", "mndw-0.0.2.ipk")

	if err := os.MkdirAll(filepath.Dir(rollbackPath), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(service.stateDir, "rollback", "version"), []byte("0.0.2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(rollbackPath, []byte("ipk"), 0o644); err != nil {
		t.Fatal(err)
	}

	service.startProcess = func(_ string, args []string, _ *os.File) error {
		want := []string{"revert", "0.0.3", "0.0.2", rollbackPath}

		if !reflect.DeepEqual(args, want) {
			t.Fatalf("helper args = %v, want %v", args, want)
		}

		return nil
	}
	accepted, err := service.BeginRevert(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if accepted.Operation != OperationRevert || accepted.TargetVersion != "0.0.2" {
		t.Fatalf("accepted = %+v", accepted)
	}
}

func TestBeginUpdateFailureAbortsAndRemovesPending(t *testing.T) {
	lease := newFakeLease(t)
	root := t.TempDir()
	ipk := filepath.Join(root, "pending.ipk")

	if err := os.WriteFile(ipk, []byte("ipk"), 0o644); err != nil {
		t.Fatal(err)
	}

	manager := &fakePackageManager{
		candidate: opkg.SelfUpdateCandidate{CurrentVersion: "0.0.3", TargetVersion: "0.0.4", PackagePath: ipk},
		lease:     lease,
	}
	service := newTestService(t, manager)
	service.packagedHelper = filepath.Join(root, "missing-helper")

	if _, err := service.BeginUpdate(context.Background()); err == nil {
		t.Fatal("BeginUpdate unexpectedly succeeded")
	}

	if !lease.aborted || lease.committed {
		t.Fatalf("lease committed=%v aborted=%v", lease.committed, lease.aborted)
	}

	if _, err := os.Stat(ipk); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending package remains: %v", err)
	}
}
