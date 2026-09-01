package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"mndwd/internal/authz"
	"mndwd/internal/palette"
	"mndwd/internal/state"
)

func deviceInfoAssembly(t *testing.T, cfg Config, verifier *authz.Verifier) components {
	t.Helper()

	if err := os.MkdirAll(cfg.UserPluginsDir, 0o700); err != nil {
		t.Fatalf("create plugin directory: %v", err)
	}

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	paletteStore, err := palette.Open(cfg.PaletteFile())
	if err != nil {
		t.Fatalf("palette.Open: %v", err)
	}

	return assemble(cfg, store, paletteStore, verifier, slog.New(slog.NewTextHandler(io.Discard, nil)), context.Background())
}

func deviceInfoConfig(t *testing.T, deviceURL string, frontendDir string, dev bool) Config {
	t.Helper()

	cfg := frontDoorTestConfig(t, frontendDir, deviceURL)
	cfg.Dev = dev

	return cfg
}

func TestDeviceInfoRouteIsAvailableWithoutFrontDoor(t *testing.T) {
	device := newFrontDoorIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/ndmConstants.json" {
			_, _ = io.WriteString(writer, `{"PORTS_MAP":{"LAN1":{"index":0,"name":"0","maxSpeed":1000}}}`)

			return
		}

		writer.WriteHeader(http.StatusNotFound)
	}))

	defer device.Close()

	cfg := deviceInfoConfig(t, device.URL, "", true)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	verifier := authz.New(cfg.DeviceURL, true, logger, authz.Options{})
	c := deviceInfoAssembly(t, cfg, verifier)

	if c.startupErr != nil {
		t.Fatalf("assemble: %v", c.startupErr)
	}

	defer c.closePersistentSession()

	defer func() { _ = c.runtime.Shutdown(context.Background()) }()

	server := newFrontDoorIPv4Server(c.handler)

	defer server.Close()

	response, err := server.Client().Get(server.URL + "/api/mgmt/device-hardware")
	if err != nil {
		t.Fatalf("GET device ports: %v", err)
	}

	defer response.Body.Close()

	body, _ := io.ReadAll(response.Body)

	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"id":"LAN1"`) {
		t.Fatalf("device ports = %d %q, want standalone normalized response", response.StatusCode, body)
	}
}

func TestDeviceInfoRouteUsesSessionGateAndReturnsBadGateway(t *testing.T) {
	var constantsStatus atomic.Int32

	constantsStatus.Store(http.StatusOK)

	device := newFrontDoorIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/auth":
			if request.Header.Get("Cookie") == "session=valid" {
				writer.WriteHeader(http.StatusOK)

				return
			}

			writer.WriteHeader(http.StatusUnauthorized)
		case "/ndmConstants.json":
			if request.Header.Get("Cookie") != "session=valid" {
				writer.WriteHeader(http.StatusUnauthorized)

				return
			}

			writer.WriteHeader(int(constantsStatus.Load()))

			if constantsStatus.Load() == http.StatusOK {
				_, _ = io.WriteString(writer, `{"PORTS_MAP":{"WAN":{"index":0,"name":"0","maxSpeed":1000}}}`)
			}
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))

	defer device.Close()

	cfg := deviceInfoConfig(t, device.URL, "", false)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	verifier := authz.New(cfg.DeviceURL, false, logger, authz.Options{Client: device.Client()})
	c := deviceInfoAssembly(t, cfg, verifier)

	if c.startupErr != nil {
		t.Fatalf("assemble: %v", c.startupErr)
	}

	defer c.closePersistentSession()

	defer func() { _ = c.runtime.Shutdown(context.Background()) }()

	server := newFrontDoorIPv4Server(c.handler)

	defer server.Close()

	get := func(cookie string) (int, string) {
		request, err := http.NewRequest(http.MethodGet, server.URL+"/api/mgmt/device-hardware", nil)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}

		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}

		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("GET device ports: %v", err)
		}

		defer response.Body.Close()

		body, _ := io.ReadAll(response.Body)

		return response.StatusCode, string(body)
	}

	if status, body := get(""); status != http.StatusUnauthorized || !strings.Contains(body, "UNAUTHORIZED") {
		t.Fatalf("unauthenticated device ports = %d %q, want 401 envelope", status, body)
	}

	if status, body := get("session=valid"); status != http.StatusOK || !strings.Contains(body, `"id":"WAN"`) {
		t.Fatalf("authenticated device ports = %d %q, want 200 response", status, body)
	}

	constantsStatus.Store(http.StatusServiceUnavailable)

	failureVerifier := authz.New(cfg.DeviceURL, false, logger, authz.Options{Client: device.Client()})
	failureComponents := deviceInfoAssembly(t, cfg, failureVerifier)

	if failureComponents.startupErr != nil {
		t.Fatalf("assemble failure handler: %v", failureComponents.startupErr)
	}

	defer failureComponents.closePersistentSession()

	defer func() { _ = failureComponents.runtime.Shutdown(context.Background()) }()

	failureServer := newFrontDoorIPv4Server(failureComponents.handler)

	defer failureServer.Close()

	failureRequest, err := http.NewRequest(http.MethodGet, failureServer.URL+"/api/mgmt/device-hardware", nil)
	if err != nil {
		t.Fatalf("build failure request: %v", err)
	}

	failureRequest.Header.Set("Cookie", "session=valid")

	failureResponse, err := failureServer.Client().Do(failureRequest)
	if err != nil {
		t.Fatalf("GET failing device ports: %v", err)
	}

	defer failureResponse.Body.Close()

	failureBody, _ := io.ReadAll(failureResponse.Body)

	if failureResponse.StatusCode != http.StatusBadGateway || !strings.Contains(string(failureBody), "BAD_GATEWAY") {
		t.Fatalf("failing device ports = %d %q, want 502 envelope", failureResponse.StatusCode, failureBody)
	}

}
