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
