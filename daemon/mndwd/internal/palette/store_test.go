package palette

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func storePath(t *testing.T) string {
	t.Helper()

	return filepath.Join(t.TempDir(), "palette.json")
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
			if _, err := os.Stat(path + ".bak"); err != nil {
				t.Errorf("original was not preserved as palette.json.bak: %v", err)
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
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Errorf("legacy document was not quarantined: %v", err)
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
