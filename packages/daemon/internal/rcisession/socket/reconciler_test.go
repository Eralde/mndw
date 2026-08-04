package socket

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestReconcilerCreatesSocketOnlyForPresentSessionAndPermission(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "rci")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	reconciler := NewReconciler(Config{MaxInflight: 8}, &fakeHandler{})
	bindings := []Binding{{PluginID: "builtin", Path: filepath.Join(root, "rci.sock")}}

	if err := reconciler.Reconcile(context.Background(), bindings[:1], false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bindings[0].Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket before session = %v", err)
	}
	if err := reconciler.Reconcile(context.Background(), bindings[:1], true); err != nil {
		skipSocketEnvironment(t, err)
		t.Fatal(err)
	}
	connection, err := net.Dial("unix", bindings[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
	if err := reconciler.Reconcile(context.Background(), nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bindings[0].Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket after session removal = %v", err)
	}
}
