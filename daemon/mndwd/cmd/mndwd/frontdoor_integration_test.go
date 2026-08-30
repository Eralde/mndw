package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mndwd/internal/authz"
	"mndwd/internal/palette"
	"mndwd/internal/rcisession"
	"mndwd/internal/state"
)

func newFrontDoorIPv4Server(handler http.Handler) *httptest.Server {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}

	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}

	server.Start()

	return server
}

func frontDoorTestConfig(t *testing.T, frontendDir, deviceURL string) Config {
	t.Helper()

	root := t.TempDir()

	return Config{
		FrontendDir:                frontendDir,
		FrontendListen:             "127.0.0.1",
		DataDir:                    filepath.Join(root, "data"),
		SelfUpdateStateDir:         filepath.Join(root, "self-update"),
		SelfUpdateHelper:           filepath.Join(root, "self-update-helper.sh"),
		RCISessionStateDir:         filepath.Join(root, "rci"),
		RCISessionKeyDir:           filepath.Join(root, "rci-secrets"),
		PluginRuntimeRoot:          filepath.Join(root, "runtime"),
		BuiltinPluginsDir:          filepath.Join(root, "builtins"),
		UserPluginsDir:             filepath.Join(root, "plugins"),
		DeviceURL:                  deviceURL,
		ControllerURL:              rcisession.DefaultControllerURL,
		Dev:                        true,
		Opkg:                       "stub",
		Service:                    "stub",
		ExecTimeout:                time.Second,
		ServiceHTTPTimeout:         time.Second,
		ServiceStopTimeout:         time.Second,
		FinalReapTimeout:           time.Second,
		RCIProxyOperationTimeout:   time.Second,
		RCIProxyMaxResponseBytes:   1 << 20,
		MaxConcurrentExecTotal:     1,
		MaxConcurrentExecPerPlugin: 1,
		MaxSupervisedServices:      1,
		SupportedServiceProtocols:  []int{1},
	}
}

func TestFrontDoorAssembly(t *testing.T) {
	frontendDir := t.TempDir()

	if err := os.WriteFile(filepath.Join(frontendDir, "index.html"), []byte("<spa/>"), 0o644); err != nil {
		t.Fatal(err)
	}

	device := newFrontDoorIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.WriteString(writer, "device:"+request.URL.Path)
	}))

	defer device.Close()

	cfg := frontDoorTestConfig(t, frontendDir, device.URL)

	if err := os.MkdirAll(cfg.UserPluginsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	paletteStore, err := palette.Open(cfg.PaletteFile())
	if err != nil {
		t.Fatalf("palette.Open: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	verifier := authz.New(cfg.DeviceURL, cfg.Dev, logger, authz.Options{})

	c := assemble(cfg, store, paletteStore, verifier, logger, context.Background())

	if c.startupErr != nil {
		c.closePersistentSession()
		t.Fatalf("assemble: %v", c.startupErr)
	}

	defer c.closePersistentSession()

	defer func() { _ = c.runtime.Shutdown(context.Background()) }()

	server := newFrontDoorIPv4Server(c.handler)

	defer server.Close()

	get := func(target string) (int, string) {
		response, err := http.Get(server.URL + target)
		if err != nil {
			t.Fatalf("GET %s: %v", target, err)
		}

		defer response.Body.Close()

		body, _ := io.ReadAll(response.Body)

		return response.StatusCode, string(body)
	}

	if _, body := get("/some/client/route"); body != "<spa/>" {
		t.Fatalf("SPA fallback body = %q, want <spa/>", body)
	}

	if _, body := get("/rci/show"); body != "device:/rci/show" {
		t.Fatalf("device proxy body = %q, want device:/rci/show", body)
	}

	if _, body := get("/api/mgmt/plugins"); body == "<spa/>" {
		t.Fatalf("/api path incorrectly captured by SPA fallback")
	}

	if code, body := get("/api/does-not-exist"); code != http.StatusNotFound || body == "<spa/>" {
		t.Fatalf("unknown /api path = %d %q, want 404 and not SPA", code, body)
	}

	if code, body := get("/ws/does-not-exist"); code != http.StatusNotFound || body == "<spa/>" {
		t.Fatalf("unknown /ws path = %d %q, want 404 and not SPA", code, body)
	}

	if code, body := get("/api/mgmt/self-update/status"); code != http.StatusOK || body == "" {
		t.Fatalf("self-update status = %d %q, want 200", code, body)
	}

	post := func(withCSRF bool) (int, string) {
		request, err := http.NewRequest(http.MethodPost, server.URL+"/api/mgmt/self-update/apply", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}

		if withCSRF {
			request.Header.Set("X-Mndw-Csrf", "1")
		}

		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}

		defer response.Body.Close()

		body, _ := io.ReadAll(response.Body)

		return response.StatusCode, string(body)
	}

	if code, body := post(false); code != http.StatusForbidden || !strings.Contains(body, "CSRF_REQUIRED") {
		t.Fatalf("self-update apply without CSRF = %d %q", code, body)
	}

	if code, body := post(true); code == http.StatusForbidden || !strings.Contains(body, "SELF_UPDATE_NOT_AVAILABLE") {
		t.Fatalf("self-update apply with CSRF = %d %q", code, body)
	}
}
