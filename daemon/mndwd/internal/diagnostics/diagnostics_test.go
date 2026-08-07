package diagnostics

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDiagnosticsCollectsPluginsAndRedactsValues(t *testing.T) {
	root := t.TempDir()
	logFile := filepath.Join(root, "mndwd.log")
	firstDir := filepath.Join(root, "first")
	secondDir := filepath.Join(root, "second")
	if err := os.MkdirAll(firstDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secondDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logFile, []byte(strings.Repeat("OLD_MARKER\n", 20)+"LATEST_MARKER"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDiagnosticsFile(t, filepath.Join(firstDir, diagnosticsFilename), `{"schemaVersion":1,"generatedAt":"2026-08-04T15:30:00Z","data":{"status":"ready","path":"/opt/runtime","credState":"absent","nested":{"token":"TOKEN_VALUE","secret":"SECRET_VALUE","authorization":"AUTH_VALUE"},"message":"authorization: DO_NOT_EXPORT"}}`)
	writeDiagnosticsFile(t, filepath.Join(secondDir, diagnosticsFilename), `{"schemaVersion":1,"generatedAt":"2026-08-04T15:31:00Z","data":{"status":"idle"}}`)

	h := New(Config{
		LogFile:             logFile,
		Plugins:             []Plugin{{ID: "first", RuntimeDir: firstDir}, {ID: "second", RuntimeDir: secondDir}},
		MaxLogBytes:         128,
		MaxPluginBytes:      1024,
		MaxTotalPluginBytes: 4096,
	})
	recorder := serveDiagnostics(t, h, true)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", got)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("content-type = %q, want application/json", got)
	}

	var response Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.GeneratedAt.IsZero() {
		t.Fatal("generatedAt is zero")
	}
	if !strings.Contains(response.Mndwd.LogTail, "LATEST_MARKER") || strings.Count(response.Mndwd.LogTail, "OLD_MARKER") >= 20 {
		t.Fatalf("log tail = %q", response.Mndwd.LogTail)
	}
	if len(response.Plugins) != 2 {
		t.Fatalf("plugins = %#v, want two results", response.Plugins)
	}
	if response.Plugins[0].PluginID != "first" || response.Plugins[1].PluginID != "second" {
		t.Fatalf("plugin order = %#v", response.Plugins)
	}
	if !response.Plugins[0].FilePresent || response.Plugins[0].GeneratedAt == nil || response.Plugins[0].FileModifiedAt == nil {
		t.Fatalf("first plugin metadata = %#v", response.Plugins[0])
	}
	if response.Plugins[0].Data["status"] != "ready" || response.Plugins[1].Data["status"] != "idle" {
		t.Fatalf("plugin data = %#v", response.Plugins)
	}
	for _, key := range []string{"token", "secret", "authorization"} {
		if response.Plugins[0].Data["nested"].(map[string]any)[key] != "[REDACTED]" {
			t.Fatalf("%s was not redacted: %#v", key, response.Plugins[0].Data)
		}
	}
	if strings.Contains(recorder.Body.String(), "TOKEN_VALUE") || strings.Contains(recorder.Body.String(), "SECRET_VALUE") || strings.Contains(recorder.Body.String(), "AUTH_VALUE") || strings.Contains(recorder.Body.String(), "DO_NOT_EXPORT") {
		t.Fatalf("response contains secret marker: %s", recorder.Body.String())
	}
}

func TestDiagnosticsReportsPluginSourceErrors(t *testing.T) {
	root := t.TempDir()
	plugins := []Plugin{
		{ID: "missing", RuntimeDir: filepath.Join(root, "missing")},
		{ID: "malformed", RuntimeDir: filepath.Join(root, "malformed")},
		{ID: "schema", RuntimeDir: filepath.Join(root, "schema")},
		{ID: "timestamp", RuntimeDir: filepath.Join(root, "timestamp")},
		{ID: "data", RuntimeDir: filepath.Join(root, "data")},
	}
	for _, plugin := range plugins[1:] {
		if err := os.MkdirAll(plugin.RuntimeDir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeDiagnosticsFile(t, filepath.Join(plugins[1].RuntimeDir, diagnosticsFilename), `{`)
	writeDiagnosticsFile(t, filepath.Join(plugins[2].RuntimeDir, diagnosticsFilename), `{"schemaVersion":2,"generatedAt":"2026-08-04T15:30:00Z","data":{}}`)
	writeDiagnosticsFile(t, filepath.Join(plugins[3].RuntimeDir, diagnosticsFilename), `{"schemaVersion":1,"data":{}}`)
	writeDiagnosticsFile(t, filepath.Join(plugins[4].RuntimeDir, diagnosticsFilename), `{"schemaVersion":1,"generatedAt":"2026-08-04T15:30:00Z","data":[]}`)

	h := New(Config{Plugins: plugins})
	recorder := serveDiagnostics(t, h, true)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var response Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Plugins) != len(plugins) {
		t.Fatalf("plugins = %#v", response.Plugins)
	}
	for index, plugin := range response.Plugins {
		if len(plugin.Errors) == 0 || plugin.Data != nil || plugin.GeneratedAt != nil {
			t.Fatalf("plugin %s result = %#v, want bounded error without data", plugins[index].ID, plugin)
		}
		if index == 0 && plugin.FilePresent {
			t.Fatalf("missing plugin marked present: %#v", plugin)
		}
		if index > 0 && !plugin.FilePresent {
			t.Fatalf("opened invalid plugin marked missing: %#v", plugin)
		}
	}
}

func TestDiagnosticsRejectsSymlinkAndNonRegularFiles(t *testing.T) {
	root := t.TempDir()
	symlinkDir := filepath.Join(root, "symlink")
	directoryDir := filepath.Join(root, "directory")
	if err := os.MkdirAll(symlinkDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(directoryDir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "secret-target")
	writeDiagnosticsFile(t, target, `{"schemaVersion":1,"generatedAt":"2026-08-04T15:30:00Z","data":{"token":"SYMLINK_SECRET"}}`)
	if err := os.Symlink(target, filepath.Join(symlinkDir, diagnosticsFilename)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directoryDir, diagnosticsFilename), 0o700); err != nil {
		t.Fatal(err)
	}

	h := New(Config{Plugins: []Plugin{{ID: "symlink", RuntimeDir: symlinkDir}, {ID: "directory", RuntimeDir: directoryDir}}})
	recorder := serveDiagnostics(t, h, true)
	if strings.Contains(recorder.Body.String(), "SYMLINK_SECRET") {
		t.Fatalf("symlink target was read: %s", recorder.Body.String())
	}
	var response Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Plugins[0].FilePresent || len(response.Plugins[0].Errors) == 0 {
		t.Fatalf("symlink result = %#v", response.Plugins[0])
	}
	if !response.Plugins[1].FilePresent || len(response.Plugins[1].Errors) == 0 {
		t.Fatalf("non-regular result = %#v", response.Plugins[1])
	}
}

func TestDiagnosticsEnforcesPerFileAndAggregateLimits(t *testing.T) {
	root := t.TempDir()
	largeDir := filepath.Join(root, "large")
	firstDir := filepath.Join(root, "first")
	secondDir := filepath.Join(root, "second")
	for _, dir := range []string{largeDir, firstDir, secondDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	largePayload := strings.Repeat("x", 128)
	writeDiagnosticsFile(t, filepath.Join(largeDir, diagnosticsFilename), largePayload)
	firstPayload := `{"schemaVersion":1,"generatedAt":"2026-08-04T15:30:00Z","data":{"status":"first"}}`
	writeDiagnosticsFile(t, filepath.Join(firstDir, diagnosticsFilename), firstPayload)
	writeDiagnosticsFile(t, filepath.Join(secondDir, diagnosticsFilename), `{"schemaVersion":1,"generatedAt":"2026-08-04T15:30:00Z","data":{"status":"second"}}`)

	h := New(Config{
		Plugins:             []Plugin{{ID: "large", RuntimeDir: largeDir}},
		MaxPluginBytes:      64,
		MaxTotalPluginBytes: 1024,
	})
	response := responseFor(t, h)
	if !response.Plugins[0].FilePresent || len(response.Plugins[0].Errors) == 0 {
		t.Fatalf("per-file limit result = %#v", response.Plugins[0])
	}

	h = New(Config{
		Plugins:             []Plugin{{ID: "first", RuntimeDir: firstDir}, {ID: "second", RuntimeDir: secondDir}},
		MaxPluginBytes:      1024,
		MaxTotalPluginBytes: int64(len(firstPayload)),
	})
	response = responseFor(t, h)
	if !response.Plugins[0].FilePresent || len(response.Plugins[0].Errors) != 0 {
		t.Fatalf("aggregate first result = %#v", response.Plugins[0])
	}
	if response.Plugins[1].FilePresent || len(response.Plugins[1].Errors) == 0 {
		t.Fatalf("aggregate-skipped result = %#v", response.Plugins[1])
	}

	currentDir := filepath.Join(root, "current")
	laterDir := filepath.Join(root, "later")
	for _, dir := range []string{currentDir, laterDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	currentPayload := `{"schemaVersion":1,"generatedAt":"2026-08-04T15:30:00Z","data":{"status":"current"}}`
	writeDiagnosticsFile(t, filepath.Join(currentDir, diagnosticsFilename), currentPayload)
	writeDiagnosticsFile(t, filepath.Join(laterDir, diagnosticsFilename), firstPayload)
	h = New(Config{
		Plugins:             []Plugin{{ID: "current", RuntimeDir: currentDir}, {ID: "later", RuntimeDir: laterDir}},
		MaxPluginBytes:      1024,
		MaxTotalPluginBytes: int64(len(currentPayload) - 1),
	})
	response = responseFor(t, h)
	if !response.Plugins[0].FilePresent || response.Plugins[0].FileModifiedAt == nil || len(response.Plugins[0].Errors) == 0 || response.Plugins[0].Data != nil {
		t.Fatalf("current aggregate overflow result = %#v", response.Plugins[0])
	}
	if response.Plugins[1].FilePresent || len(response.Plugins[1].Errors) == 0 {
		t.Fatalf("later aggregate overflow result = %#v", response.Plugins[1])
	}
}

func TestDiagnosticsEmptyPluginsAndCSRF(t *testing.T) {
	h := New(Config{})
	if response := responseFor(t, h); response.Plugins == nil || len(response.Plugins) != 0 {
		t.Fatalf("empty plugins = %#v, want empty array", response.Plugins)
	}

	recorder := serveDiagnostics(t, h, false)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "CSRF_REQUIRED" {
		t.Fatalf("error code = %q, want CSRF_REQUIRED", envelope.Error.Code)
	}
}

func TestDiagnosticsConfigDefaults(t *testing.T) {
	h := New(Config{})
	if h.config.MaxLogBytes != 64*1024 || h.config.MaxPluginBytes != 256*1024 || h.config.MaxTotalPluginBytes != 1024*1024 {
		t.Fatalf("limits = (%d, %d, %d), want (65536, 262144, 1048576)", h.config.MaxLogBytes, h.config.MaxPluginBytes, h.config.MaxTotalPluginBytes)
	}
}

func responseFor(t *testing.T, h *Handler) Response {
	t.Helper()
	recorder := serveDiagnostics(t, h, true)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	var response Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func serveDiagnostics(t *testing.T, h *Handler, csrf bool) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	h.Register(mux)
	request := httptest.NewRequest(http.MethodGet, "/api/mndw/diagnostics", nil)
	if csrf {
		request.Header.Set("X-Mndw-Csrf", "1")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func writeDiagnosticsFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Date(2026, time.August, 4, 15, 30, 0, 0, time.UTC), time.Date(2026, time.August, 4, 15, 30, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
}
