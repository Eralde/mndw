package mgmt

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

func fixtureArchive(t *testing.T, relativeDir string) ([]byte, []byte) {
	t.Helper()

	root := filepath.Join("fixtures", "i18n-packages", relativeDir)
	files := make(map[string]string)

	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if entry.IsDir() {
			return nil
		}

		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		files[filepath.ToSlash(relative)] = string(contents)

		return nil
	})
	if err != nil {
		t.Fatalf("read fixture %s: %v", relativeDir, err)
	}

	manifestBytes, ok := files["manifest.json"]

	if !ok {
		t.Fatalf("fixture %s has no manifest", relativeDir)
	}

	return makeZip(t, files), []byte(manifestBytes)
}

func openFixtureArchive(t *testing.T, relativeDir string) (*zip.Reader, *manifest.Manifest) {
	t.Helper()

	archive, manifestBytes := fixtureArchive(t, relativeDir)
	m, err := manifest.Validate(manifestBytes)
	if err != nil {
		t.Fatalf("validate fixture %s manifest: %v", relativeDir, err)
	}

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("open fixture %s archive: %v", relativeDir, err)
	}

	return zr, m
}

func TestValidateCatalogArchiveIsStructuralOnly(t *testing.T) {
	zr, m := openFixtureArchive(t, filepath.Join("invalid", "invalid-icu"))
	h := &Handler{cfg: Config{MaxUploadBytes: 10 << 20}}

	if err := h.validateCatalogArchive(zr, m); err != nil {
		t.Fatalf("malformed ICU should pass daemon structural validation: %v", err)
	}
}

func TestUploadValidatesCatalogArchives(t *testing.T) {
	tests := []struct {
		name       string
		wantStatus int
	}{
		{name: "malformed-json", wantStatus: http.StatusBadRequest},
		{name: "non-object", wantStatus: http.StatusBadRequest},
		{name: "non-string", wantStatus: http.StatusBadRequest},
		{name: "missing-file", wantStatus: http.StatusBadRequest},
		{name: "invalid-icu", wantStatus: http.StatusCreated},
		{name: "key-parity-gap", wantStatus: http.StatusCreated},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv, _ := newTestServer(t)
			directory := filepath.Join("invalid", test.name)

			if test.name == "key-parity-gap" {
				directory = filepath.Join("valid", test.name)
			}

			archive, _ := fixtureArchive(t, directory)

			resp := upload(t, srv, archive)

			defer resp.Body.Close()

			if resp.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, test.wantStatus)
			}

			if test.wantStatus == http.StatusBadRequest {
				assertCode(t, resp, "MANIFEST_INVALID")

				return
			}

			entry, ok := findEntry(listPlugins(t, srv, "/api/mgmt/list"), "i18n-parity-gap")

			if test.name == "key-parity-gap" && (!ok || entry.I18n == nil) {
				t.Fatalf("list entry did not preserve i18n descriptor: %+v", entry)
			}
		})
	}
}

func TestCatalogArchiveErrorNamesDeclaredPath(t *testing.T) {
	zr, m := openFixtureArchive(t, filepath.Join("invalid", "non-string"))
	h := &Handler{cfg: Config{MaxUploadBytes: 10 << 20}}

	err := h.validateCatalogArchive(zr, m)
	if err == nil || !strings.Contains(err.Error(), "i18n/en.json") {
		t.Fatalf("error = %v, want declared catalog path", err)
	}
}

func TestUpdateRejectsInvalidCatalogArchiveBeforeFilesystemMutation(t *testing.T) {
	srv, cfg := newTestServer(t)
	initial := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json": noBackendManifest,
		"index.js":      "old",
	}))

	initial.Body.Close()

	updateManifest := `{"manifestVersion":1,"name":"hello","version":"2.0.0","type":"widget","label":"Hello","entry":"index.js","size":{"w":4,"h":3},"i18n":{"defaultLocale":"en","locales":{"en":"i18n/en.json"}}}`
	archive := makeZip(t, map[string]string{
		"manifest.json": updateManifest,
		"index.js":      "new",
	})
	resp, err := http.Post(srv.URL+"/api/mgmt/update", "application/zip", bytes.NewReader(archive))
	if err != nil {
		t.Fatalf("update POST: %v", err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}

	assertCode(t, resp, "MANIFEST_INVALID")

	contents, err := os.ReadFile(filepath.Join(cfg.UserPluginsDir, "hello", "index.js"))
	if err != nil {
		t.Fatalf("read retained plugin: %v", err)
	}

	if string(contents) != "old" {
		t.Fatalf("retained plugin contents = %q, want old", contents)
	}
}

func TestListEntryI18nJSONShape(t *testing.T) {
	zr, m := openFixtureArchive(t, filepath.Join("valid", "alternate-and-default"))
	h := &Handler{cfg: Config{MaxUploadBytes: 10 << 20}}

	if err := h.validateCatalogArchive(zr, m); err != nil {
		t.Fatalf("valid fixture rejected: %v", err)
	}

	entry := h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true, t.TempDir())
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal list entry: %v", err)
	}

	if !strings.Contains(string(encoded), `"i18n":{"defaultLocale":"en"`) {
		t.Fatalf("encoded entry omitted i18n descriptor: %s", encoded)
	}
}
