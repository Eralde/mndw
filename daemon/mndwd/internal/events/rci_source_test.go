package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	rci "mndw.local/rci"
)

type fakeLogQueryClient struct {
	queries []rci.Query
	values  []json.RawMessage
}

func (c *fakeLogQueryClient) ExecuteRaw(_ context.Context, queries ...rci.Query) ([]json.RawMessage, []byte, error) {
	c.queries = append(c.queries, queries...)

	return c.values, nil, nil
}

func TestRCILogSourceUsesShowLogQuery(t *testing.T) {
	client := &fakeLogQueryClient{values: []json.RawMessage{json.RawMessage(`{"log":{"10":{"timestamp":"Sep  5 10:00:00","message":{"level":"Info","label":"I","message":"x"}}}}`)}}
	source := NewRCILogSource(client)

	logs, err := source.ShowLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(client.queries) != 1 || client.queries[0].Path != "show.log" {
		t.Fatalf("queries = %#v", client.queries)
	}

	if logs["10"].Timestamp != "Sep  5 10:00:00" {
		t.Fatalf("logs = %#v", logs)
	}
}

func TestQueryDeviceTimezoneExtractsConfiguredLocation(t *testing.T) {
	client, wantZone, transport := capturedTimezoneClient(t)

	loc := QueryDeviceTimezone(context.Background(), client)

	if loc == nil || loc.String() != wantZone {
		t.Fatalf("location = %v", loc)
	}

	if string(transport.requestBody) != `[{"show":{"system":{}}}]` {
		t.Fatalf("request body = %s", transport.requestBody)
	}
}

func TestQueryDeviceTimezoneFallsBackToUTC(t *testing.T) {
	client := newFailingRawQueryClient(fmt.Errorf("connection refused"))
	loc := QueryDeviceTimezone(context.Background(), client)

	if loc != time.UTC {
		t.Fatalf("fallback = %v, want UTC", loc)
	}
}

func TestQueryDeviceTimezoneHandlesUnknownZone(t *testing.T) {
	client := newRawQueryClientFromResult(t, []byte(`{"timezone":"Invalid/Zone"}`))
	loc := QueryDeviceTimezone(context.Background(), client)

	if loc != time.UTC {
		t.Fatalf("unknown zone = %v, want UTC", loc)
	}
}

func TestQueryDeviceTimezoneHandlesEmptyObject(t *testing.T) {
	client := newRawQueryClientFromResult(t, []byte(`{}`))
	loc := QueryDeviceTimezone(context.Background(), client)

	if loc != time.UTC {
		t.Fatalf("empty response = %v, want UTC", loc)
	}
}

func TestQueryDeviceTimezoneHandlesMalformedResponse(t *testing.T) {
	client, err := rci.New(&recordedTimezoneTransport{wireResponse: []byte(`[{"show":{"system":`)})
	if err != nil {
		t.Fatal(err)
	}

	loc := QueryDeviceTimezone(context.Background(), client)

	if loc != time.UTC {
		t.Fatalf("malformed response = %v, want UTC", loc)
	}
}

type recordedTimezoneTransport struct {
	wireResponse []byte
	err          error
	requestBody  []byte
}

func (t *recordedTimezoneTransport) Send(_ context.Context, body []byte) (rci.Response, error) {
	t.requestBody = append([]byte(nil), body...)

	if t.err != nil {
		return rci.Response{}, t.err
	}

	return rci.Response{Status: 200, Body: t.wireResponse}, nil
}

func capturedTimezoneClient(t *testing.T) (*rci.Client, string, *recordedTimezoneTransport) {
	t.Helper()

	wireResponse, err := os.ReadFile("testdata/device-capture/show-system.json")
	if errors.Is(err, os.ErrNotExist) {
		// unverified: response path pending target capture
		wireResponse = []byte(`[{"show":{"system":{"timezone":"Europe/Moscow"}}}]`)
		transport := &recordedTimezoneTransport{wireResponse: wireResponse}
		client, clientErr := rci.New(transport)

		if clientErr != nil {
			t.Fatal(clientErr)
		}

		return client, "Europe/Moscow", transport
	}

	if err != nil {
		t.Fatal(err)
	}

	metadata, err := os.ReadFile("testdata/device-capture/timezone.json")
	if err != nil {
		t.Fatal(err)
	}

	var recorded struct {
		Zone string `json:"zone"`
	}

	if err := json.Unmarshal(metadata, &recorded); err != nil {
		t.Fatal(err)
	}

	transport := &recordedTimezoneTransport{wireResponse: wireResponse}
	client, err := rci.New(transport)
	if err != nil {
		t.Fatal(err)
	}

	return client, recorded.Zone, transport
}

func newFailingRawQueryClient(err error) RawQueryClient {
	client, clientErr := rci.New(&recordedTimezoneTransport{err: err})

	if clientErr != nil {
		panic(clientErr)
	}

	return client
}

func newRawQueryClientFromResult(t *testing.T, result []byte) RawQueryClient {
	t.Helper()

	var value any

	if err := json.Unmarshal(result, &value); err != nil {
		t.Fatal(err)
	}

	wireResponse, err := json.Marshal([]any{map[string]any{"show": map[string]any{"system": value}}})
	if err != nil {
		t.Fatal(err)
	}

	client, err := rci.New(&recordedTimezoneTransport{wireResponse: wireResponse})
	if err != nil {
		t.Fatal(err)
	}

	return client
}
