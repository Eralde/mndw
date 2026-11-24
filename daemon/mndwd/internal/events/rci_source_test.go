package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/proxy"
)

func TestRCILogProcessRequests(t *testing.T) {
	responses := []proxy.Response{
		{Status: 200, Body: []byte(`{"log":{"1":{}}}`)},
		{Status: 200, Body: []byte(`{"log":{"2":{}}}`)},
		{Status: 200, Body: []byte(`{"log":{"3":{}}}`)},
		{Status: 204},
	}
	var requests []proxy.Request
	process := NewRCILogProcess(func(_ context.Context, request proxy.Request) (proxy.Response, error) {
		requests = append(requests, request)

		return responses[len(requests)-1], nil
	})

	if _, err := process.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	if _, err := process.Next(context.Background()); err != nil {
		t.Fatal(err)
	}

	if _, err := process.Tail(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := process.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	want := []proxy.Request{
		{Target: "controller", Method: "POST", Path: "rci/show/log", Body: []byte(`{"max-lines":100}`)},
		{Target: "controller", Method: "GET", Path: "rci/show/log"},
		{Target: "controller", Method: "POST", Path: "rci/show/log", Body: []byte(`{"once":true,"max-lines":500}`)},
		{Target: "controller", Method: "DELETE", Path: "rci/show/log", AllowWrite: true},
	}

	if len(requests) != len(want) {
		t.Fatalf("requests = %#v, want %d requests", requests, len(want))
	}

	for index, request := range requests {
		if request.Target != want[index].Target || request.Method != want[index].Method || request.Path != want[index].Path || request.AllowWrite != want[index].AllowWrite || string(request.Body) != string(want[index].Body) {
			t.Errorf("request %d = %#v, want %#v", index, request, want[index])
		}
	}
}

func TestRCILogProcessNextGoneOn404(t *testing.T) {
	process := NewRCILogProcess(func(context.Context, proxy.Request) (proxy.Response, error) {
		return proxy.Response{Status: 404}, nil
	})

	if _, err := process.Next(context.Background()); !errors.Is(err, ErrLogProcessGone) {
		t.Fatalf("Next error = %v, want ErrLogProcessGone", err)
	}
}

func TestRCILogProcessDecodesShapes(t *testing.T) {
	const record = `{"timestamp":"Sep  5 10:00:00","ident":"ndm","message":{"level":"Info","label":"I","message":"started"}}`

	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "log envelope", body: `{"log":{"10":` + record + `}}`, want: "10"},
		{name: "show envelope", body: `{"show":{"log":{"10":` + record + `}}}`, want: "10"},
		{name: "without log field", body: `{"10":` + record + `}`},
		{name: "empty body"},
		{name: "empty object", body: `{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			process := NewRCILogProcess(func(context.Context, proxy.Request) (proxy.Response, error) {
				return proxy.Response{Status: 200, Body: []byte(test.body)}, nil
			})
			logs, err := process.Start(context.Background())
			if err != nil {
				t.Fatal(err)
			}

			if test.want == "" {
				if len(logs) != 0 {
					t.Fatalf("logs = %#v, want empty", logs)
				}

				return
			}

			if len(logs) != 1 || logs[test.want].Message.Message != "started" {
				t.Fatalf("logs = %#v, want record %q", logs, test.want)
			}
		})
	}
}

func TestRCILogProcessRejectsHTTPErrorStatus(t *testing.T) {
	process := NewRCILogProcess(func(context.Context, proxy.Request) (proxy.Response, error) {
		return proxy.Response{Status: 503}, nil
	})

	if _, err := process.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("Start error = %v, want status 503", err)
	}
}

func TestQueryDeviceTimezoneExtractsConfiguredLocation(t *testing.T) {
	client, wantZone, transport := capturedTimezoneClient(t)

	loc := QueryDeviceTimezone(context.Background(), client)

	if loc == nil || loc.String() != wantZone {
		t.Fatalf("location = %v", loc)
	}

	if string(transport.requestBody) != `[{"show":{"clock":{"date":{}}}}]` {
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
	client, err := rci.New(&recordedTimezoneTransport{wireResponse: []byte(`[{"show":{"clock":`)})
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

	wireResponse := []byte(`[{"show":{"clock":{"date":{"tz":[{"locality":"Europe/Moscow"}]}}}}]`)
	transport := &recordedTimezoneTransport{wireResponse: wireResponse}
	client, clientErr := rci.New(transport)

	if clientErr != nil {
		t.Fatal(clientErr)
	}

	return client, "Europe/Moscow", transport
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

	wireResponse, err := json.Marshal([]any{map[string]any{"show": map[string]any{"clock": map[string]any{"date": value}}}})
	if err != nil {
		t.Fatal(err)
	}

	client, err := rci.New(&recordedTimezoneTransport{wireResponse: wireResponse})
	if err != nil {
		t.Fatal(err)
	}

	return client
}
