package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagnosticsCollectsSupervisorAndReadyLiveData(t *testing.T) {
	logFile := filepath.Join(t.TempDir(), "mndwd.log")

	if err := os.WriteFile(logFile, []byte("authorization: LOG_SECRET\nLATEST_MARKER"), 0o600); err != nil {
		t.Fatal(err)
	}

	states := []string{"stopped", "capacity_blocked", "starting", "backoff", "failed", "ready"}
	called := false
	plugins := make([]Plugin, 0, len(states))

	for _, state := range states {
		state := state
		plugin := Plugin{
			ID: "plugin-" + state,
			Supervisor: func() SupervisorDiagnostics {
				return SupervisorDiagnostics{State: state, RestartCount: 2, RecentStderr: []string{"stderr"}}
			},
		}

		if state == "ready" {
			plugin.Live = func(context.Context) ([]byte, error) {
				called = true

				return []byte(`{"status":"ready","nested":{"token":"LIVE_SECRET"},"items":[{"authorization":"AUTH_SECRET"}]}`), nil
			}
		}

		plugins = append(plugins, plugin)
	}

	response := responseFor(t, New(Config{LogFile: logFile, Plugins: func() []Plugin { return plugins }}))

	if !called {
		t.Fatal("ready service live callback was not called")
	}

	for index, state := range states {
		plugin := response.Plugins[index]

		if plugin.Supervisor.State != state {
			t.Fatalf("state[%d] = %q, want %q", index, plugin.Supervisor.State, state)
		}

		if state == "ready" {
			if plugin.Live.Status != "available" || plugin.Live.Data["status"] != "ready" {
				t.Fatalf("ready live result = %#v", plugin.Live)
			}
		} else if plugin.Live.Status != "unavailable" || plugin.Live.Reason != state {
			t.Fatalf("%s live result = %#v", state, plugin.Live)
		}
	}

	body := mustJSON(t, response)

	if strings.Contains(body, "LIVE_SECRET") || strings.Contains(body, "AUTH_SECRET") || strings.Contains(body, "LOG_SECRET") {
		t.Fatalf("diagnostics leaked secret: %s", body)
	}

	if !strings.Contains(response.Mndwd.LogTail, "LATEST_MARKER") {
		t.Fatalf("log tail = %q", response.Mndwd.LogTail)
	}
}

func TestCollectReadsPluginListPerRequest(t *testing.T) {
	plugins := []Plugin{{ID: "first"}}
	handler := New(Config{Plugins: func() []Plugin { return plugins }})

	if got := responseFor(t, handler).Plugins; len(got) != 1 || got[0].PluginID != "first" {
		t.Fatalf("first response plugins = %+v", got)
	}

	plugins = []Plugin{{ID: "second"}}

	if got := responseFor(t, handler).Plugins; len(got) != 1 || got[0].PluginID != "second" {
		t.Fatalf("second response plugins = %+v", got)
	}
}

func TestDiagnosticsLiveFailuresAreIndependentAndBounded(t *testing.T) {
	plugins := []Plugin{
		{
			ID: "bad",
			Supervisor: func() SupervisorDiagnostics {
				return SupervisorDiagnostics{State: "ready"}
			},
			Live: func(context.Context) ([]byte, error) {
				return []byte(`{"not":"closed"`), errors.New("service unavailable")
			},
		},
		{
			ID: "valid",
			Supervisor: func() SupervisorDiagnostics {
				return SupervisorDiagnostics{State: "ready"}
			},
			Live: func(context.Context) ([]byte, error) { return []byte(`{"status":"ok"}`), nil },
		},
		{
			ID: "oversize",
			Supervisor: func() SupervisorDiagnostics {
				return SupervisorDiagnostics{State: "ready"}
			},
			Live: func(context.Context) ([]byte, error) { return []byte(`{"data":"123456789"}`), nil },
		},
	}
	response := responseFor(t, New(Config{Plugins: func() []Plugin { return plugins }, MaxPluginBytes: 16, MaxTotalPluginBytes: 1024}))

	if response.Plugins[0].Live.Status != "unavailable" || !strings.Contains(response.Plugins[0].Live.Reason, "service unavailable") {
		t.Fatalf("failed live result = %#v", response.Plugins[0].Live)
	}

	if response.Plugins[1].Live.Status != "available" {
		t.Fatalf("valid live result = %#v", response.Plugins[1].Live)
	}

	if response.Plugins[2].Live.Status != "unavailable" || !strings.Contains(response.Plugins[2].Live.Reason, "per-plugin") {
		t.Fatalf("oversize live result = %#v", response.Plugins[2].Live)
	}

	aggregate := New(Config{
		Plugins: func() []Plugin {
			return []Plugin{
				{ID: "first", Supervisor: func() SupervisorDiagnostics { return SupervisorDiagnostics{State: "ready"} }, Live: func(context.Context) ([]byte, error) { return []byte(`{"one":1}`), nil }},
				{ID: "second", Supervisor: func() SupervisorDiagnostics { return SupervisorDiagnostics{State: "ready"} }, Live: func(context.Context) ([]byte, error) { return []byte(`{"two":2}`), nil }},
			}
		},
		MaxPluginBytes:      1024,
		MaxTotalPluginBytes: 10,
	})
	aggregateResponse := responseFor(t, aggregate)

	if aggregateResponse.Plugins[0].Live.Status != "available" || aggregateResponse.Plugins[1].Live.Status != "unavailable" {
		t.Fatalf("aggregate results = %#v", aggregateResponse.Plugins)
	}
}

func TestDiagnosticsRequiresObjectJSONAndAlwaysIncludesSupervisor(t *testing.T) {
	plugins := []Plugin{
		{ID: "array", Supervisor: func() SupervisorDiagnostics { return SupervisorDiagnostics{State: "ready"} }, Live: func(context.Context) ([]byte, error) { return []byte(`[]`), nil }},
		{ID: "missing", Supervisor: nil},
	}
	response := responseFor(t, New(Config{Plugins: func() []Plugin { return plugins }}))

	if response.Plugins[0].Live.Status != "unavailable" || !strings.Contains(response.Plugins[0].Live.Reason, "object") {
		t.Fatalf("array result = %#v", response.Plugins[0].Live)
	}

	if response.Plugins[1].Supervisor.State != "stopped" || response.Plugins[1].Live.Reason != "stopped" {
		t.Fatalf("missing supervisor result = %#v", response.Plugins[1])
	}
}

func TestDiagnosticsExportUsesPOSTAndCSRF(t *testing.T) {
	h := New(Config{})

	if recorder := serveDiagnostics(t, h, http.MethodPost, "/api/mndw/diagnostics/export", true); recorder.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200", recorder.Code)
	}

	if recorder := serveDiagnostics(t, h, http.MethodPost, "/api/mndw/diagnostics/export", false); recorder.Code != http.StatusForbidden {
		t.Fatalf("POST without CSRF status = %d, want 403", recorder.Code)
	}

	if recorder := serveDiagnostics(t, h, http.MethodGet, "/api/mndw/diagnostics/export", true); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET export status = %d, want 405", recorder.Code)
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

	recorder := serveDiagnostics(t, h, http.MethodGet, "/api/mndw/diagnostics", true)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}

	var response Response

	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}

	return response
}

func serveDiagnostics(t *testing.T, h *Handler, method, path string, csrf bool) *httptest.ResponseRecorder {
	t.Helper()

	mux := http.NewServeMux()

	h.Register(mux)

	request := httptest.NewRequest(method, path, nil)

	if csrf {
		request.Header.Set("X-Mndw-Csrf", "1")
	}

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, request)

	return recorder
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()

	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}

	return string(data)
}
