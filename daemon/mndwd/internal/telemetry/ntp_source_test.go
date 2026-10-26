package telemetry

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/telemetry/timekeeper"
)

func TestRCINTPSourceUsesSelectorAndTimeout(t *testing.T) {
	client, err := rci.New(rci.TransportFunc(func(ctx context.Context, request []byte) (rci.Response, error) {
		deadline, ok := ctx.Deadline()

		if !ok {
			t.Fatal("NTP request has no deadline")
		}

		if time.Until(deadline) > 5*time.Second {
			t.Fatalf("NTP timeout = %s, want at most 5s", time.Until(deadline))
		}

		if !strings.Contains(string(request), `"show"`) || !strings.Contains(string(request), `"ntp"`) || !strings.Contains(string(request), `"status"`) {
			t.Fatalf("request = %s, want show.ntp.status selector", request)
		}

		var query []map[string]json.RawMessage

		if err := json.Unmarshal(request, &query); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		if len(query) != 1 || query[0]["show"] == nil {
			t.Fatalf("query = %s, want show selector", request)
		}

		return rci.Response{Status: 200, Body: []byte(`[{"show":{"ntp":{"status":{}}}}]`)}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	source := NewRCINTPSource(client)

	if _, err := source(context.Background()); err != nil {
		t.Fatalf("NTP source error = %v", err)
	}
}

func TestRCINTPSourceReturnsStatusObjectFromEnvelope(t *testing.T) {
	body := `[{"show":{"ntp":{"status":{"elapsed":12,"server":"0.pool.ntp.org","accurate":true,` +
		`"synchronized":true,"ndsstime":false,"usertime":false}}}}]`
	client, err := rci.New(rci.TransportFunc(func(context.Context, []byte) (rci.Response, error) {
		return rci.Response{Status: 200, Body: []byte(body)}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	raw, err := NewRCINTPSource(client)(context.Background())
	if err != nil {
		t.Fatalf("NTP source error = %v", err)
	}

	status, err := timekeeper.DecodeNTPStatus(raw)
	if err != nil {
		t.Fatalf("DecodeNTPStatus() error = %v", err)
	}

	if !status.IsEvidence() || status.Server != "0.pool.ntp.org" || status.ElapsedS != 12 {
		t.Fatalf("status = %+v from %s, want accurate evidence from 0.pool.ntp.org with elapsed 12", status, raw)
	}
}

func TestRCINTPSourceMissingStatusIsError(t *testing.T) {
	client, err := rci.New(rci.TransportFunc(func(context.Context, []byte) (rci.Response, error) {
		return rci.Response{Status: 200, Body: []byte(`[{"show":{"ntp":{}}}]`)}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	if raw, err := NewRCINTPSource(client)(context.Background()); err == nil {
		t.Fatalf("NTP source = %s, want an error for a missing status object", raw)
	}
}
