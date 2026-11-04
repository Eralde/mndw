package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/httpx"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// demoManifest is the known-valid service manifest from
// contracts-go/fixtures/manifests/valid/backend-service.json plus public and
// mutation routes. Routes used by tests: "health" (http, public), "status"
// (http, non-public GET), "mutate" (http, non-public POST), and "terminal"
// (websocket, non-public).
const demoManifest = `{"manifestVersion":1,"name":"demo","version":"3.0.0","type":"page","label":"Demo","entry":"index.js","route":"/demo","backend":{"kind":"service","protocolVersion":1,"command":"backend/server","args":["--foreground"],"packages":["ttyd"],"routes":[{"id":"health","transport":"http","method":"GET","path":"health","access":"public"},{"id":"status","transport":"http","method":"GET","path":"status"},{"id":"mutate","transport":"http","method":"POST","path":"mutate"},{"id":"terminal","transport":"websocket","path":"terminal","protocols":["tty"]}]}}`

type fakeAuth struct {
	err   *httpx.APIError
	calls int
}

func (f *fakeAuth) Authenticate(*http.Request) *httpx.APIError {
	f.calls++

	return f.err
}

func authPass() *fakeAuth { return &fakeAuth{err: nil} }

func authFail() *fakeAuth {
	return &fakeAuth{err: httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "unauthenticated")}
}

// newPreludeGateway builds a Gateway backed by a real registry containing the
// "demo" and permission-gated "gated" plugins (both approved + enabled), plus
// disabled and pending state variants that reuse the same validated manifest
// bytes. It uses a runtime for route-gate state; prelude tests never dispatch to
// a backend.
func newPreludeGateway(t *testing.T, auth Authenticator, runtimes ...*RuntimeImpl) *Gateway {
	t.Helper()

	return newPreludeGatewayWithConfig(t, auth, GatewayConfig{}, runtimes...)
}

func newPreludeGatewayWithConfig(t *testing.T, auth Authenticator, cfg GatewayConfig, runtimes ...*RuntimeImpl) *Gateway {
	t.Helper()

	root := t.TempDir()
	userDir := filepath.Join(root, "user-plugins")
	builtinDir := filepath.Join(root, "builtin")

	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	if err := store.Mutate(func(st *state.State) error {
		gatedManifest := strings.Replace(demoManifest, `"name":"demo"`, `"name":"gated","permissions":["persistent-rci-session:read"]`, 1)
		st.Plugins["demo"] = &state.Plugin{
			Name:     "demo",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: json.RawMessage(demoManifest),
		}
		st.Plugins["gated"] = &state.Plugin{
			Name:     "gated",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: json.RawMessage(gatedManifest),
		}
		st.Plugins["disabled"] = &state.Plugin{
			Name:     "disabled",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Manifest: json.RawMessage(demoManifest),
		}
		st.Plugins["pending"] = &state.Plugin{
			Name:     "pending",
			Source:   state.SourceUpload,
			Approval: state.ApprovalPending,
			Manifest: json.RawMessage(demoManifest),
		}

		return nil
	}); err != nil {
		t.Fatalf("seed plugin: %v", err)
	}

	reg := registry.New(store, userDir, builtinDir)
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

	if len(runtimes) > 0 {
		runtime = runtimes[0]
	}

	return NewGateway(cfg, reg, auth, runtime, nil)
}

// gateRequest builds a request with the path values the ServeMux would set.
func gateRequest(method, name, path, origin string) *http.Request {
	request := httptest.NewRequest(method, "/api/plugins/"+name+"/"+path, nil)

	request.SetPathValue("name", name)
	request.SetPathValue("path", path)

	if origin != "" {
		request.Header.Set("Origin", origin)
	}

	return request
}

func TestResolveAuthorizedRoute(t *testing.T) {
	for _, tc := range []struct {
		name          string
		kind          transportKind
		authOK        bool
		plugin        string
		method        string
		path          string
		origin        string
		wantOK        bool
		wantRouteID   string // asserted when wantOK
		wantStatus    int    // asserted when !wantOK
		wantCode      string // asserted when non-empty
		wantMessage   string // asserted when non-empty
		wantAuthCalls int
	}{
		{name: "http non-canonical path", kind: transportHTTP, authOK: false, plugin: "demo", path: "a//b", wantOK: false, wantStatus: http.StatusBadRequest, wantCode: httpx.CodeBadRequest, wantAuthCalls: 0},
		{name: "ws non-canonical path", kind: transportWebSocket, authOK: false, plugin: "demo", path: "a//b", wantOK: false, wantStatus: http.StatusBadRequest, wantCode: httpx.CodeBadRequest, wantAuthCalls: 0},
		{name: "ws bad origin", kind: transportWebSocket, authOK: false, plugin: "demo", path: "terminal", origin: "http://evil.test", wantOK: false, wantStatus: http.StatusForbidden, wantCode: httpx.CodeUnauthorized, wantAuthCalls: 0},
		{name: "http unknown plugin unauth -> 401", kind: transportHTTP, authOK: false, plugin: "ghost", path: "status", wantOK: false, wantStatus: http.StatusUnauthorized, wantCode: httpx.CodeUnauthorized, wantAuthCalls: 1},
		{name: "http unknown plugin authed -> 404", kind: transportHTTP, authOK: true, plugin: "ghost", path: "status", wantOK: false, wantStatus: http.StatusNotFound, wantCode: httpx.CodeRouteNotFound, wantMessage: "no such backend route", wantAuthCalls: 1},
		{name: "http no match unauth -> 401", kind: transportHTTP, authOK: false, plugin: "demo", path: "nope", wantOK: false, wantStatus: http.StatusUnauthorized, wantCode: httpx.CodeUnauthorized, wantAuthCalls: 1},
		{name: "http no match authed -> 404", kind: transportHTTP, authOK: true, plugin: "demo", path: "nope", wantOK: false, wantStatus: http.StatusNotFound, wantCode: httpx.CodeRouteNotFound, wantMessage: "no backend route matches request", wantAuthCalls: 1},
		{name: "http method mismatch -> 404", kind: transportHTTP, authOK: true, plugin: "demo", method: http.MethodPost, path: "status", wantOK: false, wantStatus: http.StatusNotFound, wantCode: httpx.CodeRouteNotFound, wantMessage: "no backend route matches request", wantAuthCalls: 1},
		{name: "http public route skips auth", kind: transportHTTP, authOK: false, plugin: "demo", path: "health", wantOK: true, wantRouteID: "health", wantAuthCalls: 0},
		{name: "http session route unauth -> 401", kind: transportHTTP, authOK: false, plugin: "demo", path: "status", wantOK: false, wantStatus: http.StatusUnauthorized, wantCode: httpx.CodeUnauthorized, wantAuthCalls: 1},
		{name: "http session route authed ok", kind: transportHTTP, authOK: true, plugin: "demo", path: "status", wantOK: true, wantRouteID: "status", wantAuthCalls: 1},
		{name: "http disabled -> 403", kind: transportHTTP, authOK: true, plugin: "disabled", path: "status", wantOK: false, wantStatus: http.StatusForbidden, wantCode: httpx.CodeDisabled, wantAuthCalls: 1},
		{name: "http pending -> 403", kind: transportHTTP, authOK: true, plugin: "pending", path: "status", wantOK: false, wantStatus: http.StatusForbidden, wantCode: httpx.CodeNotApproved, wantAuthCalls: 1},
		{name: "ws unknown plugin authed -> 404", kind: transportWebSocket, authOK: true, plugin: "ghost", path: "terminal", wantOK: false, wantStatus: http.StatusNotFound, wantCode: httpx.CodeRouteNotFound, wantMessage: "no such backend route", wantAuthCalls: 1},
		{name: "ws no match authed -> 404", kind: transportWebSocket, authOK: true, plugin: "demo", path: "nope", wantOK: false, wantStatus: http.StatusNotFound, wantCode: httpx.CodeRouteNotFound, wantMessage: "no websocket route matches request", wantAuthCalls: 1},
		{name: "ws route unauth -> 401", kind: transportWebSocket, authOK: false, plugin: "demo", path: "terminal", wantOK: false, wantStatus: http.StatusUnauthorized, wantCode: httpx.CodeUnauthorized, wantAuthCalls: 1},
		{name: "ws route authed ok", kind: transportWebSocket, authOK: true, plugin: "demo", path: "terminal", wantOK: true, wantRouteID: "terminal", wantAuthCalls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			auth := authPass()

			if !tc.authOK {
				auth = authFail()
			}

			gateway := newPreludeGateway(t, auth)

			method := tc.method

			if method == "" {
				method = http.MethodGet
			}

			request := gateRequest(method, tc.plugin, tc.path, tc.origin)
			recorder := httptest.NewRecorder()

			decision, ok := gateway.resolveAuthorizedRoute(recorder, request, tc.kind)

			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (status %d)", ok, tc.wantOK, recorder.Code)
			}

			if auth.calls != tc.wantAuthCalls {
				t.Fatalf("auth calls = %d, want %d", auth.calls, tc.wantAuthCalls)
			}

			if tc.wantOK {
				if decision.route.ID != tc.wantRouteID {
					t.Fatalf("route.ID = %q, want %q", decision.route.ID, tc.wantRouteID)
				}

				return
			}

			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}

			if tc.wantCode != "" {
				var envelope struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}

				if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
					t.Fatalf("decode error response: %v", err)
				}

				if envelope.Error.Code != tc.wantCode {
					t.Fatalf("error code = %q, want %q", envelope.Error.Code, tc.wantCode)
				}
			}

			if tc.wantMessage != "" && !strings.Contains(recorder.Body.String(), tc.wantMessage) {
				t.Fatalf("body = %q, want message %q", recorder.Body.String(), tc.wantMessage)
			}
		})
	}
}

func TestResolveAuthorizedRouteMaintenanceGateAuthenticatesFirst(t *testing.T) {
	for _, tc := range []struct {
		name     string
		kind     transportKind
		path     string
		authOK   bool
		wantCode string
		wantAuth int
	}{
		{name: "http unauthenticated", kind: transportHTTP, path: "status", wantCode: httpx.CodeUnauthorized, wantAuth: 1},
		{name: "http authenticated", kind: transportHTTP, path: "status", authOK: true, wantCode: httpx.CodeBackendMaintenance, wantAuth: 1},
		{name: "websocket unauthenticated", kind: transportWebSocket, path: "terminal", wantCode: httpx.CodeUnauthorized, wantAuth: 1},
		{name: "websocket authenticated", kind: transportWebSocket, path: "terminal", authOK: true, wantCode: httpx.CodeBackendMaintenance, wantAuth: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			auth := authFail()

			if tc.authOK {
				auth = authPass()
			}

			gateway := newPreludeGateway(t, auth)

			setTrafficBlockedForTest(gateway.runtime, "demo", true)

			recorder := httptest.NewRecorder()
			_, ok := gateway.resolveAuthorizedRoute(recorder, gateRequest(http.MethodGet, "demo", tc.path, ""), tc.kind)

			if ok {
				t.Fatal("maintenance must stop the prelude")
			}

			if recorder.Code != http.StatusUnauthorized && recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 401 or 503", recorder.Code)
			}

			if !strings.Contains(recorder.Body.String(), tc.wantCode) {
				t.Fatalf("body = %q, want error code %q", recorder.Body.String(), tc.wantCode)
			}

			if !tc.authOK && strings.Contains(recorder.Body.String(), httpx.CodeBackendMaintenance) {
				t.Fatalf("unauthenticated response disclosed plugin maintenance: %q", recorder.Body.String())
			}

			if auth.calls != tc.wantAuth {
				t.Fatalf("auth calls = %d, want %d", auth.calls, tc.wantAuth)
			}
		})
	}
}

func TestResolveAuthorizedRoutePublicRouteDuringMaintenance(t *testing.T) {
	auth := authFail()
	gateway := newPreludeGateway(t, auth)

	setTrafficBlockedForTest(gateway.runtime, "demo", true)

	recorder := httptest.NewRecorder()
	_, ok := gateway.resolveAuthorizedRoute(recorder, gateRequest(http.MethodGet, "demo", "health", ""), transportHTTP)

	if ok {
		t.Fatal("maintenance must stop the prelude")
	}

	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), httpx.CodeBackendMaintenance) {
		t.Fatalf("status/body = %d %q, want 503 %s", recorder.Code, recorder.Body.String(), httpx.CodeBackendMaintenance)
	}

	if auth.calls != 0 {
		t.Fatalf("auth calls = %d, want 0", auth.calls)
	}
}

func TestResolveAuthorizedRouteBlockedPluginAuthenticatesFirst(t *testing.T) {
	gates := NewActivationGateRegistry()

	gates.Register("persistent-rci-session:read", ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}}
	}))

	for _, tc := range []struct {
		name     string
		authOK   bool
		wantCode string
	}{
		{name: "unauthenticated", wantCode: httpx.CodeUnauthorized},
		{name: "authenticated", authOK: true, wantCode: httpx.CodeBackendBlocked},
	} {
		t.Run(tc.name, func(t *testing.T) {
			auth := authFail()

			if tc.authOK {
				auth = authPass()
			}

			gateway := newPreludeGatewayWithConfig(t, auth, GatewayConfig{ActivationGates: gates})
			recorder := httptest.NewRecorder()
			_, ok := gateway.resolveAuthorizedRoute(recorder, gateRequest(http.MethodGet, "gated", "status", ""), transportHTTP)

			if ok {
				t.Fatal("activation blocker must stop the prelude")
			}

			wantStatus := http.StatusUnauthorized

			if tc.authOK {
				wantStatus = http.StatusServiceUnavailable
			}

			if recorder.Code != wantStatus || !strings.Contains(recorder.Body.String(), tc.wantCode) {
				t.Fatalf("status/body = %d %q, want %d %s", recorder.Code, recorder.Body.String(), wantStatus, tc.wantCode)
			}

			if !tc.authOK && strings.Contains(recorder.Body.String(), httpx.CodeBackendBlocked) {
				t.Fatalf("unauthenticated response disclosed activation state: %q", recorder.Body.String())
			}

			if auth.calls != 1 {
				t.Fatalf("auth calls = %d, want 1", auth.calls)
			}
		})
	}
}

func TestGatewayRefusesTrafficDuringRuntimePlatformMaintenance(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	gateway := newPreludeGateway(t, authPass(), runtime)

	if err := runtime.BeginPlatformMaintenance(context.Background()); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	_, ok := gateway.resolveAuthorizedRoute(recorder, gateRequest(http.MethodGet, "demo", "status", ""), transportHTTP)

	if ok {
		t.Fatal("route resolved during runtime platform maintenance")
	}

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

// Non-disclosure: an unauthenticated caller gets an identical response for an
// existing private route and a missing route.
func TestResolveAuthorizedRouteDoesNotDiscloseRouteExistence(t *testing.T) {
	gateway := newPreludeGateway(t, authFail())

	existing := httptest.NewRecorder()

	gateway.resolveAuthorizedRoute(existing, gateRequest(http.MethodGet, "demo", "status", ""), transportHTTP)

	missing := httptest.NewRecorder()

	gateway.resolveAuthorizedRoute(missing, gateRequest(http.MethodGet, "demo", "nope", ""), transportHTTP)

	if existing.Code != missing.Code {
		t.Fatalf("status differs: existing=%d missing=%d", existing.Code, missing.Code)
	}

	if existing.Body.String() != missing.Body.String() {
		t.Fatalf("body differs:\n existing=%q\n missing=%q", existing.Body.String(), missing.Body.String())
	}
}

func TestHandleHTTPDoesNotDiscloseRouteExistence(t *testing.T) {
	gateway := newPreludeGateway(t, authFail())

	mux := http.NewServeMux()

	gateway.Register(mux)

	existing := httptest.NewRecorder()

	mux.ServeHTTP(existing, httptest.NewRequest(http.MethodGet, "/api/plugins/demo/status", nil))

	missing := httptest.NewRecorder()

	mux.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/api/plugins/demo/nope", nil))

	if existing.Code != http.StatusUnauthorized || missing.Code != http.StatusUnauthorized {
		t.Fatalf("want 401/401, got existing=%d missing=%d", existing.Code, missing.Code)
	}

	if existing.Body.String() != missing.Body.String() {
		t.Fatalf("body discloses route existence:\n existing=%q\n missing=%q", existing.Body.String(), missing.Body.String())
	}
}

func TestHandleHTTPKeepsCSRFAtTheTransportEdge(t *testing.T) {
	for _, csrf := range []bool{false, true} {
		t.Run(fmt.Sprintf("csrf=%t", csrf), func(t *testing.T) {
			auth := authPass()
			gateway := newPreludeGateway(t, auth)
			mux := http.NewServeMux()

			gateway.Register(mux)

			request := httptest.NewRequest(http.MethodPost, "/api/plugins/demo/mutate", nil)

			if csrf {
				request.Header.Set("X-Mndw-Csrf", "1")
			}

			recorder := httptest.NewRecorder()

			mux.ServeHTTP(recorder, request)

			wantStatus := http.StatusForbidden

			if csrf {
				wantStatus = http.StatusServiceUnavailable
			}

			if recorder.Code != wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, wantStatus)
			}

			wantCode := httpx.CodeCsrfRequired

			if csrf {
				wantCode = httpx.CodeBackendUnavailable
			}

			if !strings.Contains(recorder.Body.String(), wantCode) {
				t.Fatalf("body = %q, want error code %q", recorder.Body.String(), wantCode)
			}

			if auth.calls != 1 {
				t.Fatalf("auth calls = %d, want 1", auth.calls)
			}
		})
	}
}

func TestHandleWebSocketDoesNotDiscloseRouteExistence(t *testing.T) {
	for _, authOK := range []bool{false, true} {
		t.Run(fmt.Sprintf("authenticated=%t", authOK), func(t *testing.T) {
			auth := authFail()

			if authOK {
				auth = authPass()
			}

			gateway := newPreludeGateway(t, auth)
			mux := http.NewServeMux()

			gateway.Register(mux)

			unknown := httptest.NewRecorder()

			mux.ServeHTTP(unknown, httptest.NewRequest(http.MethodGet, "/ws/plugins/ghost/terminal", nil))

			missing := httptest.NewRecorder()

			mux.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/ws/plugins/demo/nope", nil))

			wantStatus := http.StatusUnauthorized

			if authOK {
				wantStatus = http.StatusNotFound
			}

			if unknown.Code != wantStatus || missing.Code != wantStatus {
				t.Fatalf("want %d/%d, got unknown=%d missing=%d", wantStatus, wantStatus, unknown.Code, missing.Code)
			}

			if auth.calls != 2 {
				t.Fatalf("auth calls = %d, want 2", auth.calls)
			}

			if !authOK && unknown.Body.String() != missing.Body.String() {
				t.Fatalf("body discloses route existence:\n unknown=%q\n missing=%q", unknown.Body.String(), missing.Body.String())
			}
		})
	}
}
