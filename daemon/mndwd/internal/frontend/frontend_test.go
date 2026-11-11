package frontend

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setup(t *testing.T) (*Handler, string, string) {
	t.Helper()

	fdir := t.TempDir()
	udir := t.TempDir()

	if err := os.WriteFile(filepath.Join(fdir, "index.html"), []byte("<spa/>"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(filepath.Join(fdir, "plugins", "demo"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(fdir, "plugins", "demo", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(filepath.Join(fdir, "plugins", "demo", "backend"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(fdir, "plugins", "demo", "backend", "private.bin"), []byte("private"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(filepath.Join(udir, "myplugin"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(udir, "myplugin", "u.js"), []byte("// user"), 0o644); err != nil {
		t.Fatal(err)
	}

	h, err := New(fdir, udir)
	if err != nil {
		t.Fatal(err)
	}

	return h, fdir, udir
}

func serve(h *Handler, method, target string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()

	h.Register(mux)

	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, httptest.NewRequest(method, target, nil))

	return rec
}

func TestServesExistingFile(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodGet, "/plugins/demo/app.js")

	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestSPAFallbackForUnknownGet(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodGet, "/dashboard/settings")

	if rec.Code != http.StatusOK || rec.Body.String() != "<spa/>" {
		t.Fatalf("got %d %q, want index.html", rec.Code, rec.Body.String())
	}
}

func TestNonGetUnknownReturns404(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodPost, "/dashboard/settings")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", rec.Code)
	}
}

func TestIndexHTMLNoStore(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodGet, "/")

	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("index Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
	}
}

func TestUserPluginsAlias(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodGet, "/user-plugins/myplugin/u.js")

	if rec.Code != http.StatusOK || rec.Body.String() != "// user" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestUserPluginsAliasRejectsBackendBackupsAndInvalidNames(t *testing.T) {
	h, _, udir := setup(t)

	for _, entry := range []struct {
		path string
		body string
	}{
		{path: "myplugin/backend/x", body: "private backend"},
		{path: "myplugin.previous-1.0.0/index.js", body: "old version"},
		{path: "Name/index.js", body: "invalid name"},
	} {
		full := filepath.Join(udir, filepath.FromSlash(entry.path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(entry.body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	for _, target := range []string{
		"/user-plugins/myplugin/backend/x",
		"/user-plugins/myplugin/backend",
		"/user-plugins/myplugin.previous-1.0.0/index.js",
		"/user-plugins/Name/index.js",
		"/user-plugins/myplugin",
		"/user-plugins/myplugin/",
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			rec := serve(h, method, target)
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s %s = %d %q, want 404", method, target, rec.Code, rec.Body.String())
			}
		}
	}
}

func TestBuiltinBackendFilesAreNotServed(t *testing.T) {
	h, _, _ := setup(t)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		rec := serve(h, method, "/plugins/demo/backend/private.bin")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s builtin backend = %d %q, want 404", method, rec.Code, rec.Body.String())
		}
	}
}

func TestPluginSymlinkAliasesCannotExposeDeniedFiles(t *testing.T) {
	h, fdir, udir := setup(t)

	userBackend := filepath.Join(udir, "myplugin", "backend")
	if err := os.MkdirAll(userBackend, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userBackend, "private.bin"), []byte("user private"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("backend", filepath.Join(udir, "myplugin", "public")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	builtinDir := filepath.Join(fdir, "plugins", "demo")
	if err := os.Symlink("backend", filepath.Join(builtinDir, "public")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	backup := filepath.Join(udir, "demo.previous-1.0.0")
	if err := os.MkdirAll(backup, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backup, "index.js"), []byte("backup"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../demo.previous-1.0.0", filepath.Join(udir, "myplugin", "old")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	siblingPlugin := filepath.Join(udir, "sibling")
	if err := os.MkdirAll(siblingPlugin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(siblingPlugin, "index.js"), []byte("sibling"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../sibling", filepath.Join(udir, "myplugin", "other")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	builtinSibling := filepath.Join(fdir, "plugins", "sibling")
	if err := os.MkdirAll(builtinSibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(builtinSibling, "index.js"), []byte("builtin sibling"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../sibling", filepath.Join(builtinDir, "other")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	for _, test := range []struct {
		name    string
		handler http.HandlerFunc
		path    string
	}{
		{name: "user backend alias", handler: h.serveUserPlugin, path: "/user-plugins/myplugin/public/private.bin"},
		{name: "builtin backend alias", handler: h.serveStatic, path: "/plugins/demo/public/private.bin"},
		{name: "user backup alias", handler: h.serveUserPlugin, path: "/user-plugins/myplugin/old/index.js"},
		{name: "user sibling plugin alias", handler: h.serveUserPlugin, path: "/user-plugins/myplugin/other/index.js"},
		{name: "builtin sibling plugin alias", handler: h.serveStatic, path: "/plugins/demo/other/index.js"},
		{name: "encoded backend segment", handler: h.serveUserPlugin, path: "/user-plugins/myplugin/%62ackend/private.bin"},
		{name: "double slash before backend", handler: h.serveUserPlugin, path: "/user-plugins/myplugin//backend/private.bin"},
		{name: "trailing slash directory", handler: h.serveUserPlugin, path: "/user-plugins/myplugin/"},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				req := httptest.NewRequest(method, test.path, nil)
				rec := httptest.NewRecorder()
				test.handler(rec, req)
				if rec.Code != http.StatusNotFound {
					t.Errorf("%s %s = %d %q, want 404", method, test.path, rec.Code, rec.Body.String())
				}
			}
		})
	}
}

func TestUserPluginPackageRootSymlinkStillServesIndex(t *testing.T) {
	h, _, udir := setup(t)

	devPlugin := filepath.Join(udir, "dev", "myplugin")
	if err := os.MkdirAll(devPlugin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(devPlugin, "index.js"), []byte("dev plugin"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(udir, "myplugin")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("dev", "myplugin"), filepath.Join(udir, "myplugin")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	rec := serve(h, http.MethodGet, "/user-plugins/myplugin/index.js")
	if rec.Code != http.StatusOK || rec.Body.String() != "dev plugin" {
		t.Fatalf("GET symlinked package index = %d %q, want 200 %q", rec.Code, rec.Body.String(), "dev plugin")
	}
}

func TestTraversalRejected(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodGet, "/../../etc/passwd")

	if rec.Code == http.StatusOK {
		t.Fatalf("traversal not rejected: %d", rec.Code)
	}
}

func TestTraversalGuardReturns404(t *testing.T) {
	h, _, _ := setup(t)
	mux := http.NewServeMux()

	h.Register(mux)

	guarded := TraversalGuard(mux)

	for _, target := range []string{
		"http://x/../../etc/passwd",
		"http://x/%2e%2e/%2e%2e/etc/passwd",
		"http://x/plugins/../../etc/passwd",
	} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()

		guarded.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("guard on %q = %d, want 404", target, rec.Code)
		}
	}
}

func TestDirectoryListingDisabled(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodGet, "/plugins/demo/")

	if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "app.js") {
		t.Fatalf("directory listing leaked: %q", rec.Body.String())
	}
}

func TestNewRejectsMissingDir(t *testing.T) {
	if _, err := New("", t.TempDir()); err == nil {
		t.Fatal("expected error for empty frontendDir")
	}

	if _, err := New(filepath.Join(t.TempDir(), "nope"), t.TempDir()); err == nil {
		t.Fatal("expected error for non-existent frontendDir")
	}
}

func TestServesETagAndConditionalGet(t *testing.T) {
	h, _, _ := setup(t)
	first := serve(h, http.MethodGet, "/plugins/demo/app.js")
	etag := first.Header().Get("ETag")

	if etag == "" {
		t.Fatal("expected ETag on asset response")
	}

	mux := http.NewServeMux()

	h.Register(mux)

	req := httptest.NewRequest(http.MethodGet, "/plugins/demo/app.js", nil)

	req.Header.Set("If-None-Match", etag)

	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match got %d, want 304", rec.Code)
	}
}

func TestServesRange(t *testing.T) {
	h, _, _ := setup(t)
	mux := http.NewServeMux()

	h.Register(mux)

	req := httptest.NewRequest(http.MethodGet, "/plugins/demo/app.js", nil)

	req.Header.Set("Range", "bytes=0-3")

	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("Range got %d, want 206", rec.Code)
	}

	if rec.Body.Len() != 4 {
		t.Fatalf("Range body len = %d, want 4", rec.Body.Len())
	}
}

func TestHeadServesNoBody(t *testing.T) {
	h, _, _ := setup(t)
	rec := serve(h, http.MethodHead, "/plugins/demo/app.js")

	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD got %d, want 200", rec.Code)
	}

	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD body len = %d, want 0", rec.Body.Len())
	}
}

func TestSymlinkEscapeRejected(t *testing.T) {
	h, fdir, _ := setup(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")

	if err := os.WriteFile(outside, []byte("TOP SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(fdir, "leak.txt")

	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	rec := serve(h, http.MethodGet, "/leak.txt")

	if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "TOP SECRET") {
		t.Fatalf("symlink escape served secret: %q", rec.Body.String())
	}
}

func TestSymlinkedIndexEscapeRejected(t *testing.T) {
	h, fdir, _ := setup(t)
	outside := filepath.Join(t.TempDir(), "outside-index.html")

	if err := os.WriteFile(outside, []byte("TOP SECRET INDEX"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.Remove(filepath.Join(fdir, "index.html")); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(outside, filepath.Join(fdir, "index.html")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	rec := serve(h, http.MethodGet, "/")

	if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "TOP SECRET INDEX") {
		t.Fatalf("symlinked index escaped docroot: %q", rec.Body.String())
	}
}
