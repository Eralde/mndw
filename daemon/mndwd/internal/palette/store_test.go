package palette

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func storePath(t *testing.T) string {
	t.Helper()

	return filepath.Join(t.TempDir(), "palette.json")
}

func paletteBackupPaths(t *testing.T, path string) []string {
	t.Helper()

	paths, err := filepath.Glob(path + ".bak-*")
	if err != nil {
		t.Fatalf("list palette backups: %v", err)
	}

	return paths
}

func TestOpenCreatesCanonicalEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "palette.json")

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if _, ok := store.Get(); ok {
		t.Error("fresh store reports an override, want none")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read created file: %v", err)
	}

	var doc document

	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("created file is not valid JSON: %v", err)
	}

	if doc.Version != schemaVersion || doc.Palette != nil {
		t.Errorf("created file = %+v, want version %d with null palette", doc, schemaVersion)
	}
}

func TestSetGetRoundTrip(t *testing.T) {
	path := storePath(t)
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	want := valid()

	if err := store.Set(want); err != nil {
		t.Fatalf("Set: %v", err)
	}

	got, ok := store.Get()

	if !ok || got != want {
		t.Fatalf("Get = %+v, %v; want %+v, true", got, ok, want)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}

	got, ok = reopened.Get()

	if !ok || got != want {
		t.Errorf("after reopen Get = %+v, %v; want %+v, true", got, ok, want)
	}
}

func TestSetRejectsInvalidPalette(t *testing.T) {
	store, err := Open(storePath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	bad := valid()
	bad.Dark.Accent = "nope"

	if err := store.Set(bad); err == nil {
		t.Fatal("Set with an invalid palette = nil, want error")
	}

	if _, ok := store.Get(); ok {
		t.Error("rejected Set left an override in place")
	}
}

func TestClearWritesCanonicalEmptyDocument(t *testing.T) {
	path := storePath(t)
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := store.Set(valid()); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if err := store.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}

	if _, ok := store.Get(); ok {
		t.Error("Get after Clear reports an override")
	}
}

func TestGetReturnsACopy(t *testing.T) {
	store, err := Open(storePath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := store.Set(valid()); err != nil {
		t.Fatalf("Set: %v", err)
	}

	got, _ := store.Get()
	got.Dark.Accent = "#deadbe"

	again, _ := store.Get()

	if again.Dark.Accent == "#deadbe" {
		t.Error("mutating the value returned by Get changed the store's state")
	}
}

func TestOpenQuarantinesUnusableFiles(t *testing.T) {
	cases := map[string]string{
		"corrupt JSON":         `{"version":1,"palette":{`,
		"unsupported version":  `{"version":99,"palette":null}`,
		"invalid palette":      `{"version":1,"palette":{"dark":{"bg":"nope"},"light":{}}}`,
		"unknown document key": `{"version":1,"palette":null,"extra":true}`,
		"trailing JSON":        `{"version":1,"palette":null} null`,
	}

	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := storePath(t)

			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatalf("seed file: %v", err)
			}

			store, err := Open(path)
			if err != nil {
				t.Fatalf("Open on an unusable file = %v, want nil", err)
			}

			if _, ok := store.Get(); ok {
				t.Error("recovered store reports an override")
			}

			if backups := paletteBackupPaths(t, path); len(backups) != 1 {
				t.Errorf("palette backups = %#v, want one timestamped backup", backups)
			}
		})
	}
}

func TestOpenQuarantinesLegacy14TokenPalette(t *testing.T) {
	path := storePath(t)
	current := valid()
	legacyTheme := func(tokens ThemeTokens) map[string]string {
		return map[string]string{
			"bg": tokens.Bg, "surface": tokens.Surface, "surfaceRaised": tokens.SurfaceRaised,
			"border": tokens.Border, "textSubtle": tokens.TextSubtle, "textMuted": tokens.TextMuted,
			"text": tokens.Text, "accent": tokens.Accent, "accentHover": tokens.AccentHover,
			"accentContrast": tokens.AccentContrast, "danger": tokens.Danger, "dangerBg": tokens.DangerBg,
			"success": tokens.Success, "warning": tokens.Warning,
		}
	}
	documentBytes, err := json.Marshal(map[string]any{
		"version": schemaVersion,
		"palette": map[string]any{
			"dark": legacyTheme(current.Dark), "light": legacyTheme(current.Light),
		},
	})
	if err != nil {
		t.Fatalf("marshal legacy document: %v", err)
	}

	if err := os.WriteFile(path, documentBytes, 0o644); err != nil {
		t.Fatalf("seed legacy file: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open on legacy document = %v, want nil", err)
	}

	if _, ok := store.Get(); ok {
		t.Error("legacy document became an active palette")
	}

	if backups := paletteBackupPaths(t, path); len(backups) != 1 {
		t.Errorf("legacy palette backups = %#v, want one timestamped backup", backups)
	}
}

func TestOpenKeepsEarlierCorruptPaletteBackup(t *testing.T) {
	path := storePath(t)
	first := []byte(`{"version":1,"palette":{`)

	if err := os.WriteFile(path, first, 0o600); err != nil {
		t.Fatalf("seed first corrupt palette: %v", err)
	}

	if _, err := Open(path); err != nil {
		t.Fatalf("open first corrupt palette: %v", err)
	}

	second := []byte(`{"version":77,"palette":null}`)

	if err := os.WriteFile(path, second, 0o600); err != nil {
		t.Fatalf("seed second invalid palette: %v", err)
	}

	if _, err := Open(path); err != nil {
		t.Fatalf("open second invalid palette: %v", err)
	}

	backups := paletteBackupPaths(t, path)

	if len(backups) != 2 {
		t.Fatalf("palette backup count = %d, want 2 (%#v)", len(backups), backups)
	}

	got := make(map[string]bool, len(backups))

	for _, backupPath := range backups {
		data, err := os.ReadFile(backupPath)
		if err != nil {
			t.Fatalf("read palette backup %q: %v", backupPath, err)
		}

		got[string(data)] = true
	}

	if !got[string(first)] || !got[string(second)] {
		t.Fatalf("palette backup contents = %#v, want both original invalid files", got)
	}
}

func TestOpenContinuesWhenCorruptPaletteBackupFails(t *testing.T) {
	path := storePath(t)
	original := []byte(`{"version":1,"palette":{`)

	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatalf("seed corrupt palette: %v", err)
	}

	wantErr := errors.New("backup rename failed")
	previousRename := renameBackupFile
	renameBackupFile = func(_, _ string) error { return wantErr }

	defer func() { renameBackupFile = previousRename }()

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	store, err := Open(path, logger)
	if err != nil {
		t.Fatalf("Open after backup failure: %v", err)
	}

	if _, ok := store.Get(); ok {
		t.Error("recovered store reports an override, want default palette")
	}

	if backups := paletteBackupPaths(t, path); len(backups) != 0 {
		t.Errorf("palette backups after injected failure = %#v, want none", backups)
	}

	if !strings.Contains(logs.String(), "corrupt palette backup failed") || !strings.Contains(logs.String(), wantErr.Error()) {
		t.Errorf("backup warning = %q, want injected error", logs.String())
	}
}

func TestConcurrentSetsAreSerialized(t *testing.T) {
	store, err := Open(storePath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	var wg sync.WaitGroup

	for i := 0; i < 20; i++ {
		wg.Add(1)

		go func() {
			defer wg.Done()

			if err := store.Set(valid()); err != nil {
				t.Errorf("concurrent Set: %v", err)
			}
		}()
	}

	wg.Wait()
}
