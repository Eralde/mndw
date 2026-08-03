package cli

import (
	"errors"
	"testing"

	"ping-widget/internal/config"
	"ping-widget/internal/daemon"
	"ping-widget/internal/model"
)

func TestHostsListWithFallbackUsesStoredHostsWhenSocketUnavailable(t *testing.T) {
	expectedHosts := []model.Host{{IP: "1.1.1.1", Name: "dns-one"}}

	response, err := hostsListWithFallback(
		func() (model.Response, error) {
			return model.Response{}, errors.New("socket unavailable")
		},
		func() ([]model.Host, error) {
			return expectedHosts, nil
		},
	)

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if !response.Success {
		t.Fatalf("expected success response")
	}

	hosts, ok := response.Data.([]model.Host)
	if !ok {
		t.Fatalf("expected host slice payload")
	}

	if len(hosts) != 1 || hosts[0].IP != "1.1.1.1" {
		t.Fatalf("unexpected hosts payload: %#v", hosts)
	}
}

func TestHostsListWithFallbackReturnsErrorWhenStoreLoadFails(t *testing.T) {
	_, err := hostsListWithFallback(
		func() (model.Response, error) {
			return model.Response{}, errors.New("socket unavailable")
		},
		func() ([]model.Host, error) {
			return nil, errors.New("store read failed")
		},
	)

	if err == nil {
		t.Fatalf("expected error when fallback store read fails")
	}
}

func TestStatsWithFallbackUsesStoredStatsWhenSocketUnavailable(t *testing.T) {
	hosts := []model.Host{{IP: "1.1.1.1", Name: "dns-one"}}
	samples := map[string][]model.Sample{
		"1.1.1.1": {
			{Success: true, LatencyMs: 10, At: "2026-05-01T00:00:00Z"},
			{Success: true, LatencyMs: 20, At: "2026-05-01T00:00:01Z"},
		},
	}

	response, err := statsWithFallback(
		func() (model.Response, error) {
			return model.Response{}, errors.New("socket unavailable")
		},
		func() ([]model.Host, error) {
			return hosts, nil
		},
		func() (map[string][]model.Sample, error) {
			return samples, nil
		},
	)

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if !response.Success {
		t.Fatalf("expected success response")
	}

	stats, ok := response.Data.([]model.HostStats)
	if !ok {
		t.Fatalf("expected stats payload, got %#v", response.Data)
	}

	if len(stats) != 1 {
		t.Fatalf("expected one stat row, got %d", len(stats))
	}

	expected := daemon.NewServiceState(hosts, samples).Stats()[0]
	if stats[0].IP != expected.IP || stats[0].AvgMs != expected.AvgMs {
		t.Fatalf("unexpected fallback stats: %#v", stats[0])
	}
}

func TestStatsWithFallbackReturnsErrorWhenStoreLoadFails(t *testing.T) {
	_, err := statsWithFallback(
		func() (model.Response, error) {
			return model.Response{}, errors.New("socket unavailable")
		},
		func() ([]model.Host, error) {
			return nil, errors.New("hosts load failed")
		},
		func() (map[string][]model.Sample, error) {
			return map[string][]model.Sample{}, nil
		},
	)

	if err == nil {
		t.Fatalf("expected error when host fallback load fails")
	}
}

func TestConfigHonorsEnvOverride(t *testing.T) {
	t.Setenv("MNDW_PLUGIN_RUNTIME_DIR", "/tmp/ping-test-runtime")
	t.Setenv("MNDW_PING_STATE_DIR", "/tmp/ping-test-state")

	if got := config.SocketPath(); got != "/tmp/ping-test-runtime/ping-widget.sock" {
		t.Fatalf("SocketPath = %q", got)
	}

	if got := config.StateDir(); got != "/tmp/ping-test-state" {
		t.Fatalf("StateDir = %q", got)
	}
}

func TestStopDaemonSucceedsWhenAlreadyStopped(t *testing.T) {
	t.Setenv("MNDW_PLUGIN_RUNTIME_DIR", t.TempDir())

	response, err := StopDaemon()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if !response.Success {
		t.Fatalf("expected successful response")
	}

	data, ok := response.Data.(map[string]any)
	if !ok {
		t.Fatalf("expected map data, got %#v", response.Data)
	}
	if alreadyStopped, ok := data["alreadyStopped"].(bool); !ok || !alreadyStopped {
		t.Fatalf("expected alreadyStopped=true, got %#v", data["alreadyStopped"])
	}
}
