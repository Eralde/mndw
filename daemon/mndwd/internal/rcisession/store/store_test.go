package store

import (
	"os"
	"path/filepath"
	"testing"

	"mndwd/internal/rcisession/model"
)

func TestStoreRoundTripControllerOnly(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}

	if err := opened.ReplaceController(model.TokenRecord{Token: "controller-token", Support: model.SupportSupported}); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}

	document, err := reopened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}

	if document.Controller == nil || document.Controller.Token != "controller-token" {
		t.Fatalf("controller = %#v", document.Controller)
	}
}

func TestStoreDeleteControllerLeavesEmptyDocument(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}

	if err := opened.ReplaceController(model.TokenRecord{Token: "secret"}); err != nil {
		t.Fatal(err)
	}

	if err := opened.DeleteController(); err != nil {
		t.Fatal(err)
	}

	document, err := opened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}

	if document.Controller != nil {
		t.Fatalf("controller after delete = %#v", document.Controller)
	}
}

func TestStoreMissingKeyDisablesPersistence(t *testing.T) {
	root := t.TempDir()
	config := Config{CiphertextFile: filepath.Join(root, "state", "session.enc"), KeyFile: filepath.Join(root, "missing", "session.key")}

	if err := os.MkdirAll(filepath.Dir(config.CiphertextFile), 0o700); err != nil {
		t.Fatal(err)
	}

	if _, err := Open(config); err != nil {
		t.Fatal(err)
	}
}

func testConfig(t *testing.T) Config {
	t.Helper()

	root := t.TempDir()

	return Config{CiphertextFile: filepath.Join(root, "state", "session.enc"), KeyFile: filepath.Join(root, "secrets", "session.key")}
}
