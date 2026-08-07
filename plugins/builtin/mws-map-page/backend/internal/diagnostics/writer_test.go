package diagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWriterWritesAtomicContractWithOwnerOnlyPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "diagnostics.json")
	when := time.Date(2026, time.August, 4, 15, 30, 0, 123000000, time.UTC)
	writer := Writer{Path: path, Clock: func() time.Time { return when }}

	if err := writer.Write(map[string]any{"status": "ready", "nested": map[string]any{"value": 42}}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0o600); got != want {
		t.Fatalf("mode = %o, want %o", got, want)
	}

	var envelope struct {
		SchemaVersion int            `json:"schemaVersion"`
		GeneratedAt   time.Time      `json:"generatedAt"`
		Data          map[string]any `json:"data"`
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatalf("decode file: %v; data=%s", err, data)
	}
	if envelope.SchemaVersion != 1 || !envelope.GeneratedAt.Equal(when) || envelope.Data["status"] != "ready" {
		t.Fatalf("envelope = %#v", envelope)
	}

	if err := writer.Write(map[string]any{"status": "updated"}); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(data) || !strings.Contains(string(data), `"updated"`) {
		t.Fatalf("replacement is not a complete JSON document: %s", data)
	}
}

func TestWriterDoesNotExposePayloadOnFailure(t *testing.T) {
	secret := "DO_NOT_EXPORT"
	writer := Writer{Path: filepath.Join(t.TempDir(), "missing", "diagnostics.json")}
	if err := writer.Write(map[string]any{"token": secret}); err == nil {
		t.Fatal("Write error = nil")
	} else if strings.Contains(err.Error(), secret) {
		t.Fatalf("Write error contains payload: %v", err)
	}
}
