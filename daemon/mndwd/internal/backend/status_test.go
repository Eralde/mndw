package backend

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestProjectBackendStatusMapsLifecycleAndRuntimeStates(t *testing.T) {
	now := time.Date(2026, time.August, 14, 12, 0, 0, 0, time.UTC)
	runtime := newStatusTestRuntime(now)
	gateway := &Gateway{runtime: runtime, traffic: runtime.Traffic(), activationGates: NewActivationGateRegistry()}

	service := statusTestPlugin(t, "demo", manifest.BackendKindService, 1, state.ApprovalApproved, true, nil)
	exec := statusTestPlugin(t, "exec", manifest.BackendKindExec, 0, state.ApprovalApproved, true, nil)

	tests := []struct {
		name        string
		plugin      *registry.Plugin
		status      RuntimeStatus
		maintenance bool
		wantState   string
		wantRetry   *int
	}{
		{name: "exec ready", plugin: exec, wantState: "ready"},
		{name: "service ready", plugin: service, status: RuntimeStatus{State: StateReady}, wantState: "ready"},
		{name: "service starting", plugin: service, status: RuntimeStatus{State: StateStarting, NextAttemptAt: timePtr(now.Add(3 * time.Second))}, wantState: "starting", wantRetry: intPtr(3)},
		{name: "service backoff", plugin: service, status: RuntimeStatus{State: StateBackoff}, wantState: "starting"},
		{name: "service capacity blocked", plugin: service, status: RuntimeStatus{State: StateCapacityBlocked}, wantState: "starting"},
		{name: "service stopped", plugin: service, status: RuntimeStatus{State: StateStopped}, wantState: "unavailable"},
		{name: "service failed", plugin: service, status: RuntimeStatus{State: StateFailed}, wantState: "unavailable"},
		{name: "missing supervisor record", plugin: service, wantState: "unavailable"},
		{name: "maintenance", plugin: service, maintenance: true, wantState: "maintenance", wantRetry: intPtr(2)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runtime.supervisor.services = make(map[string]*serviceRecord)

			if test.status.State != "" {
				runtime.supervisor.services[test.plugin.Name] = &serviceRecord{status: test.status}
			}

			setTrafficBlockedForTest(runtime, test.plugin.Name, test.maintenance)

			got := gateway.projectBackendStatus(test.plugin, now)

			if got.State != test.wantState {
				t.Fatalf("state = %q, want %q", got.State, test.wantState)
			}

			if !sameIntPointer(got.RetryAfterSeconds, test.wantRetry) {
				t.Fatalf("retry = %v, want %v", got.RetryAfterSeconds, test.wantRetry)
			}
		})
	}
}

func TestProjectBackendStatusUsesLifecyclePrecedenceAndStaticCompatibility(t *testing.T) {
	now := time.Date(2026, time.August, 14, 12, 0, 0, 0, time.UTC)
	runtime := newStatusTestRuntime(now)
	gateway := &Gateway{runtime: runtime, traffic: runtime.Traffic(), activationGates: NewActivationGateRegistry()}

	disabled := statusTestPlugin(t, "disabled", manifest.BackendKindService, 2, state.ApprovalApproved, false, nil)
	notApproved := statusTestPlugin(t, "pending", manifest.BackendKindService, 2, state.ApprovalPending, true, nil)
	incompatible := statusTestPlugin(t, "incompatible", manifest.BackendKindService, 2, state.ApprovalApproved, true, nil)

	for _, test := range []struct {
		name        string
		plugin      *registry.Plugin
		maintenance bool
		wantState   string
	}{
		{name: "disabled before maintenance", plugin: disabled, maintenance: true, wantState: "disabled"},
		{name: "not approved before maintenance", plugin: notApproved, maintenance: true, wantState: "not-approved"},
		{name: "incompatible", plugin: incompatible, wantState: "incompatible"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setTrafficBlockedForTest(runtime, test.plugin.Name, test.maintenance)

			got := gateway.projectBackendStatus(test.plugin, now)

			if got.State != test.wantState {
				t.Fatalf("state = %q, want %q", got.State, test.wantState)
			}
		})
	}

	got := gateway.projectBackendStatus(incompatible, now)

	if got.RequiredProtocol == nil || *got.RequiredProtocol != 2 || got.SupportedProtocols == nil || len(*got.SupportedProtocols) != 1 || (*got.SupportedProtocols)[0] != 1 {
		t.Fatalf("incompatible protocol fields = %#v", got)
	}
}

func TestProjectBackendStatusExecSkipsActivationEvaluation(t *testing.T) {
	now := time.Date(2026, time.August, 14, 12, 0, 0, 0, time.UTC)
	var calls int
	gates := NewActivationGateRegistry()

	gates.Register(manifest.PersistentRCISessionWritePermission, ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		calls++

		return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}}
	}))

	gateway := &Gateway{activationGates: gates}
	plugin := statusTestPlugin(t, "exec", manifest.BackendKindExec, 0, state.ApprovalApproved, true, []string{manifest.PersistentRCISessionWritePermission})

	got := gateway.projectBackendStatus(plugin, now)

	if got.State != "ready" {
		t.Fatalf("state = %q, want ready", got.State)
	}

	if calls != 0 {
		t.Fatalf("activation evaluator calls = %d, want 0", calls)
	}
}

func TestProjectBackendStatusPreservesTypedBlockerWireValues(t *testing.T) {
	gates := NewActivationGateRegistry()

	gates.Register(manifest.PersistentRCISessionReadPermission, ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		return []ActivationBlocker{
			{Permission: permission, Reason: BlockerNotGranted},
			{Permission: permission, Reason: BlockerPrerequisiteUnavailable, Prerequisite: "controller-token"},
		}
	}))

	gateway := &Gateway{activationGates: gates}
	plugin := statusTestPlugin(t, "demo", manifest.BackendKindService, 1, state.ApprovalApproved, true, []string{manifest.PersistentRCISessionReadPermission})

	got, err := json.Marshal(gateway.projectBackendStatus(plugin, time.Time{}))
	if err != nil {
		t.Fatal(err)
	}

	want := `{"kind":"service","state":"blocked","retryAfterSeconds":null,"blockers":[{"permission":"persistent-rci-session:read","reason":"not-granted"},{"permission":"persistent-rci-session:read","reason":"prerequisite-unavailable","prerequisite":"controller-token"}]}`

	if string(got) != want {
		t.Fatalf("status JSON = %s, want %s", got, want)
	}
}

func TestRetryAfterSecondsUsesFutureCeilingAndExpiresToNull(t *testing.T) {
	now := time.Date(2026, time.August, 14, 12, 0, 0, 0, time.UTC)

	for _, test := range []struct {
		name string
		next *time.Time
		want *int
	}{
		{name: "missing", want: nil},
		{name: "equal", next: timePtr(now), want: nil},
		{name: "past", next: timePtr(now.Add(-time.Millisecond)), want: nil},
		{name: "subsecond future", next: timePtr(now.Add(200 * time.Millisecond)), want: intPtr(1)},
		{name: "fractional future", next: timePtr(now.Add(3200 * time.Millisecond)), want: intPtr(4)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := retryAfterSeconds(now, test.next); !sameIntPointer(got, test.want) {
				t.Fatalf("retryAfterSeconds() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestStatusHandlerAuthenticatesBeforeResolutionAndSanitizesResponse(t *testing.T) {
	registry, store := statusTestRegistry(t)
	plugin := statusTestPlugin(t, "demo", manifest.BackendKindService, 1, state.ApprovalApproved, true, nil)

	statusTestStorePlugin(t, store, plugin)
	statusTestStoreBackendless(t, store, "backendless")

	auth := &statusTestAuthenticator{err: httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "unauthorized")}
	gateway := NewGateway(GatewayConfig{}, registry, auth, nil, nil)
	mux := http.NewServeMux()

	gateway.Register(mux)

	unauthenticated := httptest.NewRecorder()

	mux.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/plugins/unknown/_mndw/status", nil))

	if unauthenticated.Code != http.StatusUnauthorized || auth.calls != 1 {
		t.Fatalf("unauthenticated status = %d, auth calls = %d", unauthenticated.Code, auth.calls)
	}

	auth.err = nil
	known := httptest.NewRecorder()

	mux.ServeHTTP(known, httptest.NewRequest(http.MethodGet, "/api/plugins/demo/_mndw/status", nil))

	if known.Code != http.StatusOK || known.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("known status = %d, cache-control = %q", known.Code, known.Header().Get("Cache-Control"))
	}

	body := known.Body.String()

	for _, forbidden := range []string{"lastError", "lastExit", "recentStderr", "restartCount", "consecutiveFailures", "process", "socket"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("status body contains forbidden field %q: %s", forbidden, body)
		}
	}

	backendless := httptest.NewRecorder()

	mux.ServeHTTP(backendless, httptest.NewRequest(http.MethodGet, "/api/plugins/backendless/_mndw/status", nil))

	if backendless.Code != http.StatusNotFound {
		t.Fatalf("backendless status = %d, want 404", backendless.Code)
	}
}

type statusTestAuthenticator struct {
	calls int
	err   *httpx.APIError
}

func (a *statusTestAuthenticator) Authenticate(*http.Request) *httpx.APIError {
	a.calls++

	return a.err
}

func statusTestRegistry(t *testing.T) (*registry.Registry, *state.Store) {
	t.Helper()

	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatalf("open status registry: %v", err)
	}

	return registry.New(store, filepath.Join(root, "plugins"), filepath.Join(root, "builtins")), store
}

func statusTestStorePlugin(t *testing.T, store *state.Store, plugin *registry.Plugin) {
	t.Helper()

	data, err := json.Marshal(plugin.Manifest)
	if err != nil {
		t.Fatalf("marshal status manifest: %v", err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins[plugin.Name] = &state.Plugin{
			Name:     plugin.Name,
			Source:   state.SourceUpload,
			Approval: plugin.Approval,
			Enabled:  plugin.Enabled,
			Manifest: data,
		}

		return nil
	}); err != nil {
		t.Fatalf("store status plugin: %v", err)
	}
}

func statusTestStoreBackendless(t *testing.T, store *state.Store, name string) {
	t.Helper()

	data := []byte(fmt.Sprintf(`{"manifestVersion":1,"name":"%s","version":"1.0.0","type":"page","label":"%s","entry":"index.js","route":"/%s"}`, name, name, name))

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins[name] = &state.Plugin{Name: name, Source: state.SourceUpload, Approval: state.ApprovalApproved, Enabled: true, Manifest: data}

		return nil
	}); err != nil {
		t.Fatalf("store backendless plugin: %v", err)
	}
}

func newStatusTestRuntime(now time.Time) *RuntimeImpl {
	return NewRuntime(RuntimeConfig{
		SupportedServiceProtocols: []int{1},
		Supervisor:                SupervisorConfig{Now: func() time.Time { return now }},
	})
}

func setTrafficBlockedForTest(runtime *RuntimeImpl, pluginID string, blocked bool) {
	runtime.supervisor.withLock(func() {
		if !blocked {
			delete(runtime.supervisor.coord.records, pluginID)

			return
		}

		runtime.supervisor.coord.records[pluginID] = &transition{intent: IntentStop}
	})
}

func statusTestPlugin(t *testing.T, name string, kind manifest.BackendKind, protocol int, approval state.Approval, enabled bool, permissions []string) *registry.Plugin {
	t.Helper()

	permissionJSON := "[]"

	if len(permissions) > 0 {
		permissionJSON = fmt.Sprintf(`["%s"]`, permissions[0])
	}

	backend := fmt.Sprintf(`"kind":"%s","routes":[{"id":"status","transport":"http","method":"GET","path":"status","command":"backend/status.sh"}]`, kind)

	if kind == manifest.BackendKindService {
		backend = fmt.Sprintf(`"kind":"%s","protocolVersion":%d,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]`, kind, protocol)
	}

	data := []byte(fmt.Sprintf(`{"manifestVersion":1,"name":"%s","version":"1.0.0","type":"page","label":"%s","entry":"index.js","route":"/%s","permissions":%s,"backend":{%s}}`, name, name, name, permissionJSON, backend))
	parsed, err := manifest.Validate(data)
	if err != nil {
		t.Fatalf("validate status plugin: %v", err)
	}

	return &registry.Plugin{Name: name, Dir: t.TempDir(), Manifest: parsed, Approval: approval, Enabled: enabled}
}

func intPtr(value int) *int { return &value }

func timePtr(value time.Time) *time.Time { return &value }

func sameIntPointer(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}

	return *left == *right
}
