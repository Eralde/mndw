package mgmt

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/backend"
	"mndwd/internal/opkg"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type testRuntimeResolver struct {
	plugin *registry.Plugin
	ok     bool
	called int
	name   string
}

func (r *testRuntimeResolver) Resolve(name string) (*registry.Plugin, bool) {
	r.called++
	r.name = name

	return r.plugin, r.ok
}

func newRuntimeResolverTestHandler(t *testing.T, resolver RuntimeResolver) (*Handler, *state.Store) {
	t.Helper()

	store, err := state.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	err = store.Mutate(func(st *state.State) error {
		st.Plugins["svc"] = &state.Plugin{
			Name:             "svc",
			Source:           state.SourceUpload,
			Approval:         state.ApprovalApproved,
			Enabled:          true,
			Manifest:         []byte(serviceBackendManifest),
			ActiveVersionDir: "/active/svc",
		}

		return nil
	})
	if err != nil {
		t.Fatalf("store.Mutate: %v", err)
	}

	cfg := Config{UserPluginsDir: "/user/plugins", RuntimeResolver: resolver, Runtime: passthroughRuntime{}}
	handler := New(cfg, store, opkg.New("stub", discardLogger()), nil, emptyBuiltinSource{}, discardLogger())

	return handler, store
}

func TestRuntimeResolverHitUsesResolvedPlugin(t *testing.T) {
	want := &registry.Plugin{Name: "resolved"}
	resolver := &testRuntimeResolver{plugin: want, ok: true}
	handler, _ := newRuntimeResolverTestHandler(t, resolver)

	got, ok := handler.resolveRuntimePlugin("svc")

	if !ok || got != want {
		t.Fatalf("resolved plugin = (%p, %t), want (%p, true)", got, ok, want)
	}

	if resolver.called != 1 || resolver.name != "svc" {
		t.Fatalf("resolver calls = %d for %q, want one call for svc", resolver.called, resolver.name)
	}
}

func TestRuntimeResolverMissDoesNotFallBackToStore(t *testing.T) {
	resolver := &testRuntimeResolver{ok: false}
	handler, _ := newRuntimeResolverTestHandler(t, resolver)

	if plugin, ok := handler.resolveRuntimePlugin("svc"); ok || plugin != nil {
		t.Fatalf("resolver miss returned store plugin: (%+v, %t)", plugin, ok)
	}

	if resolver.called != 1 || resolver.name != "svc" {
		t.Fatalf("resolver calls = %d for %q, want one call for svc", resolver.called, resolver.name)
	}
}

func TestRuntimeResolverAbsentUsesStoreFallback(t *testing.T) {
	handler, _ := newRuntimeResolverTestHandler(t, nil)

	plugin, ok := handler.resolveRuntimePlugin("svc")

	if !ok || plugin == nil {
		t.Fatalf("store fallback plugin = (%+v, %t), want a plugin", plugin, ok)
	}

	if plugin.Name != "svc" || plugin.Dir != "/active/svc" || !plugin.Enabled {
		t.Fatalf("store fallback plugin = %+v", plugin)
	}
}

func TestRestartUsesExplicitRuntimeResolver(t *testing.T) {
	resolver := &testRuntimeResolver{ok: true}
	handler, store := newRuntimeResolverTestHandler(t, resolver)
	resolved, ok := registry.New(store, "/user/plugins", "").Resolve("svc")

	if !ok {
		t.Fatal("registry did not resolve seeded service")
	}

	resolver.plugin = resolved
	runtime := &lifecycleTestRuntime{store: store}
	handler.runtime = runtime

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/mgmt/restart", strings.NewReader(`{"name":"svc"}`))

	handler.handleRestart(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("restart status = %d, body=%s", response.Code, response.Body.String())
	}

	if resolver.called != 1 || resolver.name != "svc" {
		t.Fatalf("resolver calls = %d for %q, want one call for svc", resolver.called, resolver.name)
	}

	if len(runtime.calls) != 1 || runtime.calls[0].op != backend.OpRestarting {
		t.Fatalf("restart lifecycle calls = %+v", runtime.calls)
	}
}
