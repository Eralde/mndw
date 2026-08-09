package socket

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestReconcilerCreatesSocketOnlyForPresentSession(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "rci")
	if err != nil {
		t.Fatal(err)
	}

	defer os.RemoveAll(root)

	reconciler := NewReconciler(Config{MaxInflight: 8}, &fakeHandler{})
	bindings := []Binding{{PluginID: "builtin", Path: filepath.Join(root, "rci.sock"), Grants: Grants{CanRead: true, CanWrite: true}}}

	report, err := reconciler.Reconcile(context.Background(), bindings[:1], false)
	if err != nil {
		t.Fatal(err)
	}

	if report.Desired["builtin"] || report.Active["builtin"] {
		t.Fatalf("report before session = %+v", report)
	}

	if _, err := os.Stat(bindings[0].Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket before session = %v", err)
	}

	report, err = reconciler.Reconcile(context.Background(), bindings[:1], true)
	if err != nil {
		skipSocketEnvironment(t, err)
		t.Fatal(err)
	}

	if startErr := report.StartErrors["builtin"]; startErr != nil {
		skipSocketEnvironment(t, startErr)
		t.Fatal(startErr)
	}

	if !report.Desired["builtin"] || !report.Active["builtin"] {
		t.Fatalf("report after session = %+v", report)
	}

	connection, err := net.Dial("unix", bindings[0].Path)
	if err != nil {
		t.Fatal(err)
	}

	connection.Close()

	report, err = reconciler.Reconcile(context.Background(), nil, false)
	if err != nil {
		t.Fatal(err)
	}

	if report.Active["builtin"] {
		t.Fatalf("report after removal = %+v", report)
	}

	if _, err := os.Stat(bindings[0].Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket after session removal = %v", err)
	}
}

func TestReconcilerReportsEveryPluginStartFailure(t *testing.T) {
	root := t.TempDir()
	blockedParent := filepath.Join(root, "not-a-directory")

	if err := os.WriteFile(blockedParent, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	reconciler := NewReconciler(Config{}, &fakeHandler{})
	goodPath := filepath.Join(root, "good.sock")
	badPath := filepath.Join(blockedParent, "bad.sock")

	defer reconciler.Close()

	report, err := reconciler.Reconcile(context.Background(), []Binding{
		{PluginID: "bad", Path: badPath, Grants: Grants{CanRead: true}},
		{PluginID: "good", Path: goodPath, Grants: Grants{CanRead: true}},
	}, true)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if startErr := report.StartErrors["good"]; startErr != nil {
		skipSocketEnvironment(t, startErr)
		t.Fatal(startErr)
	}

	if report.StartErrors["bad"] == nil {
		t.Fatalf("start errors = %+v, want bad plugin failure", report.StartErrors)
	}

	if report.Active["bad"] {
		t.Fatalf("bad plugin active: %+v", report)
	}

	if !report.Desired["bad"] || !report.Desired["good"] || !report.Active["good"] {
		t.Fatalf("report = %+v", report)
	}
}

func TestReconcilerRejectsDuplicateAndEmptyPluginIDsBeforeMutation(t *testing.T) {
	root := t.TempDir()
	reconciler := NewReconciler(Config{}, &fakeHandler{})
	path := filepath.Join(root, "socket.sock")

	if _, err := reconciler.Reconcile(context.Background(), []Binding{
		{PluginID: "same", Path: path},
		{PluginID: "same", Path: filepath.Join(root, "other.sock")},
	}, true); err == nil {
		t.Fatal("duplicate plugin ID accepted")
	}

	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("duplicate validation created socket: %v", err)
	}

	if _, err := reconciler.Reconcile(context.Background(), []Binding{{Path: path}}, true); err == nil {
		t.Fatal("empty plugin ID accepted")
	}
}
