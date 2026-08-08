package mgmt

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"mndwd/internal/opkg"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type emptyBuiltinSource struct{}

func (emptyBuiltinSource) ListBuiltinsWithError() ([]*registry.Plugin, error) {
	return nil, nil
}

func newTestServer(t *testing.T) (*httptest.Server, Config) {
	t.Helper()
	root := t.TempDir()
	cfg := Config{
		StagingDir:        filepath.Join(root, "staging"),
		UserPluginsDir:    filepath.Join(root, "user-plugins"),
		BuiltinPluginsDir: filepath.Join(root, "builtin"),
		MaxUploadBytes:    10 << 20,
	}
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	New(cfg, store, opkg.New("stub", logger), registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir), logger).Register(mux)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, cfg
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestServerWithOpkg(t *testing.T, opkgMgr opkg.Manager) (*httptest.Server, Config) {
	t.Helper()
	root := t.TempDir()
	cfg := Config{
		StagingDir:        filepath.Join(root, "staging"),
		UserPluginsDir:    filepath.Join(root, "user-plugins"),
		BuiltinPluginsDir: filepath.Join(root, "builtin"),
		MaxUploadBytes:    10 << 20,
	}
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	logger := discardLogger()
	mux := http.NewServeMux()
	New(cfg, store, opkgMgr, registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir), logger).Register(mux)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, cfg
}

// writeBuiltinFixture drops a minimal valid widget manifest into the builtin dir.
func writeBuiltinFixture(t *testing.T, cfg Config, name string, fixedHeight bool) {
	t.Helper()
	dir := filepath.Join(cfg.BuiltinPluginsDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fixedHeightField := ""
	if fixedHeight {
		fixedHeightField = `,"fixedHeight":true`
	}
	manifest := `{"manifestVersion":3,"name":"` + name + `","version":"0.1.0","type":"widget","label":"` + name + `","entry":"index.js","size":{"w":4,"h":3}` + fixedHeightField + `}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
}

// makeZip builds an in-memory plugin archive from path→content pairs.
func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}

	return buf.Bytes()
}

func upload(t *testing.T, srv *httptest.Server, zipBytes []byte) *http.Response {
	t.Helper()
	resp, err := http.Post(srv.URL+"/api/mgmt/upload", "application/zip", bytes.NewReader(zipBytes))
	if err != nil {
		t.Fatalf("upload POST: %v", err)
	}

	return resp
}

func postName(t *testing.T, srv *httptest.Server, path, name string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name})
	resp, err := http.Post(srv.URL+path, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}

	return resp
}

func listPlugins(t *testing.T, srv *httptest.Server, path string) []ListEntry {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()

	var out struct {
		Plugins []ListEntry `json:"plugins"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode list: %v", err)
	}

	return out.Plugins
}

func findEntry(entries []ListEntry, name string) (ListEntry, bool) {
	for _, e := range entries {
		if e.Name == name {
			return e, true
		}
	}

	return ListEntry{}, false
}

const noBackendManifest = `{
  "manifestVersion": 3, "name": "hello", "version": "1.0.0",
  "type": "widget", "label": "Hello", "entry": "index.js",
  "size": {"w": 4, "h": 3}
}`

const backendManifest = `{
  "manifestVersion": 3, "name": "svc", "version": "1.0.0",
  "type": "widget", "label": "Service", "entry": "index.js",
  "size": {"w": 6, "h": 4},
  "backend": {
    "kind": "exec",
    "packages": ["curl"],
    "routes": [{"id": "e1", "transport": "http", "method": "GET", "path": "run", "command": "backend/run.sh"}]
  }
}`

func TestUploadNoBackendInstallsDirectly(t *testing.T) {
	srv, cfg := newTestServer(t)

	resp := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json": noBackendManifest,
		"index.js":      "export function createInstance(){}",
	}))
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}

	entries := listPlugins(t, srv, "/api/mgmt/list")
	e, ok := findEntry(entries, "hello")
	if !ok {
		t.Fatalf("hello not in list")
	}
	if e.Approval != state.ApprovalApproved || !e.Enabled {
		t.Errorf("no-backend plugin should be approved+enabled, got approval=%s enabled=%v", e.Approval, e.Enabled)
	}

	// Files must have moved out of staging into user-plugins.
	if _, err := os.Stat(filepath.Join(cfg.UserPluginsDir, "hello", "index.js")); err != nil {
		t.Errorf("expected installed file in user-plugins: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cfg.StagingDir, "hello")); !os.IsNotExist(err) {
		t.Errorf("staging should be empty after direct install")
	}
}

func TestUploadBackendPendingThenApprove(t *testing.T) {
	srv, cfg := newTestServer(t)

	resp := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "export function createInstance(){}",
		"backend/run.sh": "#!/bin/sh\necho hi\n",
	}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("upload status = %d, want 202", resp.StatusCode)
	}

	// Shows up as pending with its declared capabilities.
	pending := listPlugins(t, srv, "/api/mgmt/pending")
	e, ok := findEntry(pending, "svc")
	if !ok {
		t.Fatalf("svc not in pending list")
	}
	if e.Approval != state.ApprovalPending {
		t.Errorf("expected pending, got %s", e.Approval)
	}
	if _, ok := e.Backend.Routes["e1"]; !ok {
		t.Errorf("expected route e1 in descriptor, got %+v", e.Backend.Routes)
	}

	// Approve.
	ap := postName(t, srv, "/api/mgmt/approve", "svc")
	defer ap.Body.Close()
	if ap.StatusCode != http.StatusOK {
		t.Fatalf("approve status = %d, want 200", ap.StatusCode)
	}

	entries := listPlugins(t, srv, "/api/mgmt/list")
	e, _ = findEntry(entries, "svc")
	if e.Approval != state.ApprovalApproved || !e.Enabled {
		t.Errorf("after approve want approved+enabled, got approval=%s enabled=%v", e.Approval, e.Enabled)
	}

	// Script moved to user-plugins and made executable.
	scriptPath := filepath.Join(cfg.UserPluginsDir, "svc", "backend", "run.sh")
	info, err := os.Stat(scriptPath)
	if err != nil {
		t.Fatalf("expected approved script installed: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("approved script should be executable, mode=%o", info.Mode().Perm())
	}

	// Nothing left in pending.
	if p := listPlugins(t, srv, "/api/mgmt/pending"); len(p) != 0 {
		t.Errorf("expected empty pending after approve, got %d", len(p))
	}
}

func TestDenyRemovesStaging(t *testing.T) {
	srv, cfg := newTestServer(t)

	resp := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	}))
	resp.Body.Close()

	dn := postName(t, srv, "/api/mgmt/deny", "svc")
	defer dn.Body.Close()
	if dn.StatusCode != http.StatusOK {
		t.Fatalf("deny status = %d, want 200", dn.StatusCode)
	}

	if _, err := os.Stat(filepath.Join(cfg.StagingDir, "svc")); !os.IsNotExist(err) {
		t.Errorf("staging should be gone after deny")
	}
	if entries := listPlugins(t, srv, "/api/mgmt/list"); len(entries) != 0 {
		t.Errorf("denied plugin should not be listed, got %d", len(entries))
	}
}

func TestDeleteInstalledPlugin(t *testing.T) {
	srv, cfg := newTestServer(t)

	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json": noBackendManifest, "index.js": "x",
	})).Body.Close()

	del := postName(t, srv, "/api/mgmt/delete", "hello")
	defer del.Body.Close()
	if del.StatusCode != http.StatusOK {
		t.Fatalf("delete status = %d, want 200", del.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(cfg.UserPluginsDir, "hello")); !os.IsNotExist(err) {
		t.Errorf("plugin files should be gone after delete")
	}
	if entries := listPlugins(t, srv, "/api/mgmt/list"); len(entries) != 0 {
		t.Errorf("deleted plugin should not be listed")
	}
}

func TestDuplicateUploadConflicts(t *testing.T) {
	srv, _ := newTestServer(t)
	z := makeZip(t, map[string]string{"manifest.json": noBackendManifest, "index.js": "x"})

	upload(t, srv, z).Body.Close()
	resp := upload(t, srv, z)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate upload status = %d, want 409", resp.StatusCode)
	}
	assertCode(t, resp, "CONFLICT")
}

func TestUploadInvalidManifest(t *testing.T) {
	srv, _ := newTestServer(t)
	bad := `{"manifestVersion": 3, "name": "BadName!!", "version": "1", "type": "widget", "label": "x", "entry": "index.js", "size": {"w":4,"h":3}}`

	resp := upload(t, srv, makeZip(t, map[string]string{"manifest.json": bad, "index.js": "x"}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	assertCode(t, resp, "MANIFEST_INVALID")
}

func TestUploadNonZip(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := upload(t, srv, []byte("this is not a zip file at all"))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	assertCode(t, resp, "INVALID_ZIP")
}

func TestUploadMissingManifest(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := upload(t, srv, makeZip(t, map[string]string{"index.js": "x"}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	assertCode(t, resp, "MANIFEST_MISSING")
}

func TestUploadTooLarge(t *testing.T) {
	srv, _ := newTestServer(t)
	// Shrink the cap below the payload via a second server would need config access;
	// instead upload a body larger than the fixed 10 MB cap.
	big := bytes.Repeat([]byte("A"), int(11<<20))
	resp, err := http.Post(srv.URL+"/api/mgmt/upload", "application/zip", bytes.NewReader(big))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	assertCode(t, resp, "UPLOAD_TOO_LARGE")
}

func TestUploadZipSlipRejected(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json": noBackendManifest,
		"index.js":      "x",
		"../escape.txt": "pwned",
	}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("zip-slip status = %d, want 400", resp.StatusCode)
	}
	assertCode(t, resp, "INVALID_ZIP")
}

func TestApproveUnknownPlugin(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postName(t, srv, "/api/mgmt/approve", "ghost")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestApproveNonPendingConflicts(t *testing.T) {
	srv, _ := newTestServer(t)
	upload(t, srv, makeZip(t, map[string]string{"manifest.json": noBackendManifest, "index.js": "x"})).Body.Close()
	// hello is approved (no backend); approving again is a conflict.
	resp := postName(t, srv, "/api/mgmt/approve", "hello")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
}

func TestBuiltinAppearsInList(t *testing.T) {
	srv, cfg := newTestServer(t)
	// Seed a builtin on disk.
	bdir := filepath.Join(cfg.BuiltinPluginsDir, "core-demo")
	if err := os.MkdirAll(bdir, 0o755); err != nil {
		t.Fatal(err)
	}
	builtin := `{"manifestVersion":3,"name":"core-demo","version":"2.0.0","type":"page","label":"Demo","entry":"index.js","route":"/demo"}`
	if err := os.WriteFile(filepath.Join(bdir, "manifest.json"), []byte(builtin), 0o644); err != nil {
		t.Fatal(err)
	}

	e, ok := findEntry(listPlugins(t, srv, "/api/mgmt/list"), "core-demo")
	if !ok {
		t.Fatalf("builtin not listed")
	}
	if e.Source != state.SourceBuiltin || e.Approval != state.ApprovalApproved || !e.Enabled {
		t.Errorf("builtin should be builtin/approved/enabled, got %s/%s/%v", e.Source, e.Approval, e.Enabled)
	}
}

func TestStatePluginNameReservesBuiltinInList(t *testing.T) {
	root := t.TempDir()
	cfg := Config{
		StagingDir:        filepath.Join(root, "staging"),
		UserPluginsDir:    filepath.Join(root, "user-plugins"),
		BuiltinPluginsDir: filepath.Join(root, "builtin"),
	}
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["core-demo"] = &state.Plugin{
			Name:     "core-demo",
			Source:   state.SourceUser,
			Approval: state.ApprovalPending,
			Manifest: json.RawMessage(`{"manifestVersion":3,"name":"core-demo","version":"1.0.0","type":"widget","label":"User","entry":"index.js","size":{"w":4,"h":3}}`),
		}

		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	writeBuiltinFixture(t, cfg, "core-demo", false)

	handler := New(cfg, store, opkg.New("stub", discardLogger()), registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir), discardLogger())
	mux := http.NewServeMux()
	handler.Register(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mgmt/list", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", recorder.Code)
	}
	var body struct {
		Plugins []ListEntry `json:"plugins"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(body.Plugins) != 1 {
		t.Fatalf("plugin count = %d, want 1: %+v", len(body.Plugins), body.Plugins)
	}
	if body.Plugins[0].Source != state.SourceUser || body.Plugins[0].Approval != state.ApprovalPending {
		t.Fatalf("collision entry = %+v, want pending user entry", body.Plugins[0])
	}
}

func TestSymlinkedBuiltinAppearsInList(t *testing.T) {
	srv, cfg := newTestServer(t)
	if err := os.MkdirAll(cfg.BuiltinPluginsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	sourceDir := filepath.Join(t.TempDir(), "clients-widget")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	builtin := `{"manifestVersion":3,"name":"clients-widget","version":"1.0.0","type":"widget","label":"Clients","entry":"index.js","size":{"w":4,"h":3}}`
	if err := os.WriteFile(filepath.Join(sourceDir, "manifest.json"), []byte(builtin), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sourceDir, filepath.Join(cfg.BuiltinPluginsDir, "clients-widget")); err != nil {
		t.Fatal(err)
	}

	if _, ok := findEntry(listPlugins(t, srv, "/api/mgmt/list"), "clients-widget"); !ok {
		t.Fatalf("symlinked builtin not listed")
	}
}

func TestMutationResponsesCarryDepsStatus(t *testing.T) {
	srv, _ := newTestServer(t)

	zipBytes := makeZip(t, map[string]string{
		"manifest.json": `{"manifestVersion":3,"name":"up-widget","version":"0.1.0","type":"widget","label":"up-widget","entry":"index.js","size":{"w":4,"h":3}}`,
		"index.js":      "export function createInstance() {}",
	})
	resp := upload(t, srv, zipBytes)
	defer resp.Body.Close()

	var entry ListEntry
	if err := json.NewDecoder(resp.Body).Decode(&entry); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if entry.DepsStatus != "ready" {
		t.Errorf("upload response depsStatus = %q, want ready", entry.DepsStatus)
	}
}

func TestWrongMethodRejected(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/mgmt/upload") // upload is POST-only
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
}

func TestEnableDisableTogglesState(t *testing.T) {
	srv, _ := newTestServer(t)
	// Backend plugin without a daemon: approve → enabled, then disable/enable.
	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\necho hi\n",
	})).Body.Close()
	postName(t, srv, "/api/mgmt/approve", "svc").Body.Close()

	dis := postName(t, srv, "/api/mgmt/disable", "svc")
	defer dis.Body.Close()
	if dis.StatusCode != http.StatusOK {
		t.Fatalf("disable status = %d, want 200", dis.StatusCode)
	}
	e, _ := findEntry(listPlugins(t, srv, "/api/mgmt/list"), "svc")
	if e.Enabled {
		t.Errorf("plugin should be disabled")
	}

	en := postName(t, srv, "/api/mgmt/enable", "svc")
	defer en.Body.Close()
	if en.StatusCode != http.StatusOK {
		t.Fatalf("enable status = %d, want 200", en.StatusCode)
	}
	e, _ = findEntry(listPlugins(t, srv, "/api/mgmt/list"), "svc")
	if !e.Enabled {
		t.Errorf("plugin should be enabled again")
	}
}

func TestEnableUnknownPlugin(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postName(t, srv, "/api/mgmt/enable", "ghost")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestApproveInstallsOpkgDeps(t *testing.T) {
	srv, _ := newTestServer(t)
	// backendManifest declares opkg ["curl"].
	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	})).Body.Close()
	postName(t, srv, "/api/mgmt/approve", "svc").Body.Close()

	// The stub opkg should now report curl installed.
	resp, err := http.Get(srv.URL + "/api/mgmt/opkg/list-installed")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Packages []string `json:"packages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range out.Packages {
		if p == "curl" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected curl installed after approve, got %v", out.Packages)
	}
}

func TestOpkgInstallSuccessPreservesResponse(t *testing.T) {
	srv, _ := newTestServer(t)
	body, _ := json.Marshal(map[string][]string{"packages": {"curl"}})
	resp, err := http.Post(srv.URL+"/api/mgmt/opkg/install", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var result struct {
		OK       bool     `json:"ok"`
		Message  string   `json:"message"`
		Packages []string `json:"packages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Message != "1 package(s) installed" || len(result.Packages) != 1 || result.Packages[0] != "curl" {
		t.Errorf("install response = %+v", result)
	}
}

func assertCode(t *testing.T, resp *http.Response, wantCode string) {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if env.Error.Code != wantCode {
		t.Errorf("error code = %q, want %q", env.Error.Code, wantCode)
	}
}
