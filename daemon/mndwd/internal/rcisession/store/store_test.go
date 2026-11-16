package store

import (
	"crypto/aes"
	"crypto/cipher"
	"errors"
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

func TestStoreLoadsDocumentWithLegacyExtendersField(t *testing.T) {
	config := testConfig(t)

	if _, err := Open(config); err != nil {
		t.Fatal(err)
	}

	key, err := os.ReadFile(config.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}

	nonce := make([]byte, gcm.NonceSize())
	plaintext := []byte(`{"controller":{"token":"controller-token","support":"supported"},"extenders":[{"identity":"old"}]}`)
	ciphertext := append(nonce, gcm.Seal(nil, nonce, plaintext, nil)...)

	if err := os.WriteFile(config.CiphertextFile, ciphertext, 0o600); err != nil {
		t.Fatal(err)
	}

	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}

	if got := opened.State(); got != model.StateOK {
		t.Fatalf("Open().State() = %q, want %q", got, model.StateOK)
	}

	document, err := opened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}

	if document.Controller == nil || document.Controller.Token != "controller-token" {
		t.Fatalf("Snapshot().Controller = %#v", document.Controller)
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

func TestDisabledStoreReportsDisabled(t *testing.T) {
	store := Disabled()

	if got := store.State(); got != model.StateDisabled {
		t.Fatalf("Disabled().State() = %q, want %q", got, model.StateDisabled)
	}

	if _, err := store.Snapshot(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Disabled().Snapshot() error = %v, want ErrUnavailable", err)
	}
}

func testConfig(t *testing.T) Config {
	t.Helper()

	root := t.TempDir()

	return Config{CiphertextFile: filepath.Join(root, "state", "session.enc"), KeyFile: filepath.Join(root, "secrets", "session.key")}
}
