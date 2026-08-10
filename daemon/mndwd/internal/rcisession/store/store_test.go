package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mndwd/internal/rcisession/model"
)

func TestOpenCreatesKeyAndStartsEmpty(t *testing.T) {
	config := testConfig(t)

	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if opened.State() != model.StateEmpty {
		t.Fatalf("state = %q, want empty", opened.State())
	}
	info, err := os.Stat(config.KeyFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode = %o, want 600", info.Mode().Perm())
	}
}

func TestOpenKeyOnlyStartsRecoverableEmpty(t *testing.T) {
	config := testConfig(t)
	if _, err := Open(config); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.State() != model.StateEmpty {
		t.Fatalf("state = %q, want empty", reopened.State())
	}
}

func TestStoreRoundTripAndReopen(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}

	checked := time.Unix(123, 456).UTC()
	record := model.TokenRecord{
		Key:           "token-key",
		Token:         "token-secret",
		Support:       model.SupportSupported,
		LastCheckedAt: &checked,
		LastError:     "",
	}
	if err := opened.ReplaceController(record); err != nil {
		t.Fatal(err)
	}
	if err := opened.UpsertExtender("node-1", record); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := reopened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Controller == nil || snapshot.Controller.Token != "token-secret" {
		t.Fatalf("controller snapshot = %#v", snapshot.Controller)
	}
	if snapshot.Extenders["node-1"].Key != "token-key" {
		t.Fatalf("extender snapshot = %#v", snapshot.Extenders)
	}
	if reopened.State() != model.StateOK {
		t.Fatalf("state = %q, want ok", reopened.State())
	}
}

func TestMissingKeyPreservesCiphertextAndDisablesStore(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := opened.ReplaceController(testRecord()); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(config.CiphertextFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(config.KeyFile); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.State() != model.StateDisabled {
		t.Fatalf("state = %q, want disabled", reopened.State())
	}
	if _, err := reopened.Snapshot(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Snapshot error = %v, want ErrUnavailable", err)
	}
	current, err := os.ReadFile(config.CiphertextFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != string(original) {
		t.Fatal("ciphertext changed after missing-key recovery")
	}
}

func TestWrongKeyPreservesCiphertextAndFailsClosed(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := opened.ReplaceController(testRecord()); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(config.CiphertextFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.KeyFile, []byte(strings.Repeat("x", 32)), 0o600); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.State() != model.StateDecryptFailed {
		t.Fatalf("state = %q, want decrypt-failed", reopened.State())
	}
	current, err := os.ReadFile(config.CiphertextFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != string(original) {
		t.Fatal("ciphertext changed after wrong-key recovery")
	}
}

func TestCorruptCiphertextFailsClosedWithoutWiping(t *testing.T) {
	config := testConfig(t)
	if _, err := Open(config); err != nil {
		t.Fatal(err)
	}
	corrupt := []byte("preserve me")
	if err := os.WriteFile(config.CiphertextFile, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.State() != model.StateDecryptFailed {
		t.Fatalf("state = %q, want decrypt-failed", reopened.State())
	}
	current, err := os.ReadFile(config.CiphertextFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != string(corrupt) {
		t.Fatal("corrupt ciphertext was changed")
	}
}

func TestRejectsKeySymlink(t *testing.T) {
	config := testConfig(t)
	if err := os.MkdirAll(filepath.Dir(config.KeyFile), 0o700); err != nil {
		t.Fatal(err)
	}
	actual := filepath.Join(filepath.Dir(config.KeyFile), "actual.key")
	if err := os.WriteFile(actual, make([]byte, 32), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(actual, config.KeyFile); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(config); err == nil {
		t.Fatal("Open accepted symlink key")
	}
}

func TestRejectsUnsafeKeyMode(t *testing.T) {
	config := testConfig(t)
	if err := os.MkdirAll(filepath.Dir(config.KeyFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.KeyFile, make([]byte, 32), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(config); err == nil {
		t.Fatal("Open accepted key mode 0644")
	}
}

func TestUnavailableErrorsDoNotContainSecrets(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	secret := "never-log-this-token"
	if err := opened.ReplaceController(model.TokenRecord{Key: "key", Token: secret, Support: model.SupportSupported}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(config.KeyFile); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Snapshot(); err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("error = %v, contains secret or is nil", err)
	}
}

func TestSnapshotIsDefensiveAndMutationsSerialize(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := opened.ReplaceController(testRecord()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := opened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Controller.Token = "changed"
	snapshot.Extenders["new"] = testRecord()
	second, err := opened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if second.Controller.Token == "changed" || len(second.Extenders) != 0 {
		t.Fatalf("snapshot mutated store: %#v", second)
	}

	var wait sync.WaitGroup
	for index := 0; index < 4; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			record := testRecord()
			record.Key = string(rune('a' + index))
			if err := opened.UpsertExtender("node-"+string(rune('0'+index)), record); err != nil {
				t.Errorf("UpsertExtender() error = %v", err)
			}
		}(index)
	}
	wait.Wait()
	final, err := opened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(final.Extenders) != 4 {
		t.Fatalf("extender count = %d, want 4", len(final.Extenders))
	}
}

func TestMutationRetainsInMemoryChangeWhenPersistenceFails(t *testing.T) {
	config := testConfig(t)
	opened, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}

	failedTarget := filepath.Join(t.TempDir(), "ciphertext-directory")
	if err := os.Mkdir(failedTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	opened.file = failedTarget

	if err := opened.ReplaceController(testRecord()); err == nil {
		t.Fatal("ReplaceController() error = nil, want persistence error")
	}

	snapshot, err := opened.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Controller == nil || snapshot.Controller.Token != "secret" {
		t.Fatalf("in-memory document = %#v, want retained mutation", snapshot)
	}
}

func testConfig(t *testing.T) Config {
	t.Helper()
	root := t.TempDir()
	return Config{
		CiphertextFile: filepath.Join(root, "state", "rci-session.enc"),
		KeyFile:        filepath.Join(root, "secret", "rci-session.key"),
	}
}

func testRecord() model.TokenRecord {
	return model.TokenRecord{Key: "key", Token: "secret", Support: model.SupportSupported}
}
