package opkg

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseUpgradableCandidate(t *testing.T) {
	got, ok, err := parseUpgradable("curl - 1 - 2\nmndw - 0.0.3 - 0.0.4\n", "mndw")
	if err != nil || !ok || got.CurrentVersion != "0.0.3" || got.TargetVersion != "0.0.4" {
		t.Fatalf("candidate=%+v ok=%v err=%v", got, ok, err)
	}
}

func TestParseUpgradableRejectsDuplicateMndwRows(t *testing.T) {
	_, _, err := parseUpgradable("mndw - 0.0.3 - 0.0.4\nmndw - 0.0.3 - 0.0.5\n", "mndw")
	if err == nil {
		t.Fatal("duplicate mndw candidate unexpectedly accepted")
	}
}

func TestPrepareSelfUpdateDownloadsNormalizedCandidate(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		StateDir:   filepath.Join(root, "state"),
		PendingDir: filepath.Join(root, "pending"),
		LockPath:   filepath.Join(root, "state", "opkg.lock"),
	}

	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg update":
			return "", 0, nil
		case "opkg list-installed mndw":
			return "mndw - 0.0.3\n", 0, nil
		case "opkg list-upgradable":
			return "mndw - 0.0.3 - 0.0.4\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}

	downloadRunner := func(_ context.Context, dir string, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg download mndw" {
			t.Fatalf("download args = %v", args)
		}

		if err := os.WriteFile(filepath.Join(dir, "mndw_0.0.4_mipsel-3.4.ipk"), []byte("ipk"), 0o644); err != nil {
			t.Fatal(err)
		}

		return "", 0, nil
	}

	m := &execManager{
		logger:         discard(),
		runner:         runner,
		downloadRunner: downloadRunner,
		gate:           make(chan struct{}, 1),
		stateDir:       paths.StateDir,
		pendingDir:     paths.PendingDir,
		lockPath:       paths.LockPath,
	}

	candidate, lease, err := m.PrepareSelfUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer lease.Abort()

	if candidate.CurrentVersion != "0.0.3" || candidate.TargetVersion != "0.0.4" {
		t.Fatalf("candidate = %+v", candidate)
	}

	if candidate.PackagePath != filepath.Join(paths.PendingDir, "mndw-0.0.4.ipk") {
		t.Fatalf("package path = %q", candidate.PackagePath)
	}

	if _, err := os.Stat(candidate.PackagePath); err != nil {
		t.Fatalf("normalized IPK: %v", err)
	}
}
