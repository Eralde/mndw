package rci

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

var _ Transport = TransportFunc(nil)

type recordingTransport struct {
	response Response
	err      error
	calls    int
	contexts []context.Context
	bodies   [][]byte
}

type pointerTransport struct{}

func (t *recordingTransport) Send(ctx context.Context, body []byte) (Response, error) {
	t.calls++
	t.contexts = append(t.contexts, ctx)
	t.bodies = append(t.bodies, append([]byte(nil), body...))
	return t.response, t.err
}

func newRecordingClient(t *testing.T, response Response, transportErr error) (*Client, *recordingTransport) {
	t.Helper()
	transport := &recordingTransport{response: response, err: transportErr}
	client, err := New(transport)
	if err != nil {
		t.Fatal(err)
	}
	return client, transport
}

func TestTransportFuncForwardsContextBodyAndResult(t *testing.T) {
	type contextKey string
	ctx := context.WithValue(context.Background(), contextKey("key"), "value")
	wantResponse := Response{Status: 200, Body: []byte(`{"ok":true}`)}
	wantErr := errors.New("transport failure")
	var gotContext context.Context
	var gotBody []byte
	transport := TransportFunc(func(gotCtx context.Context, body []byte) (Response, error) {
		gotContext = gotCtx
		gotBody = body
		return wantResponse, wantErr
	})

	gotResponse, gotErr := transport.Send(ctx, []byte(`{"request":true}`))
	if gotContext != ctx || string(gotBody) != `{"request":true}` {
		t.Fatalf("forwarded context/body = (%v, %s), want original values", gotContext, gotBody)
	}
	if !reflect.DeepEqual(gotResponse, wantResponse) || !errors.Is(gotErr, wantErr) {
		t.Fatalf("forwarded result = (%#v, %v), want (%#v, %v)", gotResponse, gotErr, wantResponse, wantErr)
	}
}

func TestNewRejectsNilTransportShapes(t *testing.T) {
	tests := []struct {
		name      string
		transport Transport
	}{
		{name: "nil interface", transport: nil},
		{name: "typed nil pointer", transport: (*pointerTransport)(nil)},
		{name: "nil function", transport: TransportFunc(nil)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := New(test.transport)
			if !errors.Is(err, ErrNilTransport) {
				t.Fatalf("New(%s) = %v, want ErrNilTransport", test.name, err)
			}
		})
	}
}

func (pointerTransport) Send(context.Context, []byte) (Response, error) {
	return Response{}, nil
}

func TestExecuteManyValidatesAllQueriesBeforeSend(t *testing.T) {
	client, transport := newRecordingClient(t, Response{Status: 200, Body: []byte(`[]`)}, nil)

	queries := []Query{Q("show.version"), Q("show..system")}
	values, err := client.ExecuteMany(context.Background(), queries...)
	var queryErr *QueryError
	if values != nil || !errors.As(err, &queryErr) || queryErr.Index != 1 || queryErr.Path != "show..system" || !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("ExecuteMany invalid path = (%#v, %v), want indexed QueryError", values, err)
	}
	if transport.calls != 0 {
		t.Fatalf("Send calls = %d, want 0", transport.calls)
	}
}

func TestExecuteManyReportsInvalidQueryAtItsInputIndex(t *testing.T) {
	client, transport := newRecordingClient(t, Response{Status: 200, Body: []byte(`[]`)}, nil)
	_, err := client.ExecuteMany(context.Background(), Q("show.version"), Q("show.system"), Q("show..memory"))
	var queryErr *QueryError
	if !errors.As(err, &queryErr) || queryErr.Index != 2 || queryErr.Path != "show..memory" || !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("ExecuteMany invalid path = %v, want index 2 QueryError", err)
	}
	if transport.calls != 0 {
		t.Fatalf("Send calls = %d, want 0", transport.calls)
	}
}

func TestExecuteManyPreservesMarshalCauseAndIndex(t *testing.T) {
	client, transport := newRecordingClient(t, Response{Status: 200, Body: []byte(`[]`)}, nil)
	values, err := client.ExecuteMany(context.Background(), Q("show.version"), Q("show.system", make(chan int)))
	var queryErr *QueryError
	var marshalErr *json.UnsupportedTypeError
	if values != nil || !errors.As(err, &queryErr) || queryErr.Index != 1 || !errors.As(err, &marshalErr) {
		t.Fatalf("ExecuteMany marshal failure = (%#v, %v), want indexed marshal cause", values, err)
	}
	if transport.calls != 0 {
		t.Fatalf("Send calls = %d, want 0", transport.calls)
	}
}

func TestExecuteManyBuildsOrderedBodyAndExtractsResults(t *testing.T) {
	client, transport := newRecordingClient(t, Response{
		Status: 200,
		Body:   []byte(`[{"show":{"version":1}},{"show":{"system":{"name":"router"}}}]`),
	}, nil)

	values, err := client.ExecuteMany(context.Background(), Q("show.version"), Q("show.system"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(values[0]), `1`; got != want {
		t.Fatalf("version = %s, want %s", got, want)
	}
	if got, want := string(values[1]), `{"name":"router"}`; got != want {
		t.Fatalf("system = %s, want %s", got, want)
	}
	if len(transport.bodies) != 1 || string(transport.bodies[0]) != `[{"show":{"version":{}}},{"show":{"system":{}}}]` {
		t.Fatalf("request body = %s, want ordered command array", transport.bodies[0])
	}
}

func TestExecuteManyResponseLengthContract(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		queries    []Query
		wantValues []string
	}{
		{name: "short", body: `[{"show":{"version":1}}]`, queries: []Query{Q("show.version"), Q("show.system")}, wantValues: []string{`1`, ""}},
		{name: "long", body: `[{"show":{"version":1}},{"show":{"system":2}}]`, queries: []Query{Q("show.version")}, wantValues: []string{`1`}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, _ := newRecordingClient(t, Response{Status: 200, Body: []byte(test.body)}, nil)
			values, err := client.ExecuteMany(context.Background(), test.queries...)
			if err != nil {
				t.Fatal(err)
			}
			if len(values) != len(test.wantValues) {
				t.Fatalf("values length = %d, want %d", len(values), len(test.wantValues))
			}
			for index, want := range test.wantValues {
				if string(values[index]) != want {
					t.Fatalf("values[%d] = %s, want %s", index, values[index], want)
				}
			}
		})
	}
}

func TestExecuteManyRejectsInvalidTopLevelResponses(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "empty", body: ""},
		{name: "null", body: "null"},
		{name: "object", body: `{}`},
		{name: "scalar", body: `1`},
		{name: "trailing garbage", body: `[] trailing`},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, _ := newRecordingClient(t, Response{Status: 200, Body: []byte(test.body)}, nil)
			values, err := client.ExecuteMany(context.Background(), Q("show.version"))
			if values != nil || !errors.Is(err, ErrInvalidResponse) {
				t.Fatalf("ExecuteMany(%s) = (%#v, %v), want nil values and ErrInvalidResponse", test.name, values, err)
			}
		})
	}
}

func TestExecuteManyFansOutDuplicatesAndHonorsRawPerInput(t *testing.T) {
	client, transport := newRecordingClient(t, Response{
		Status: 200,
		Body:   []byte(`[{"show":{"version":1,"system":{"name":"router"}}}]`),
	}, nil)
	queries := []Query{Q("show.version"), {Path: "show.version", Raw: true}, Q("show.version")}

	values, err := client.ExecuteMany(context.Background(), queries...)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`1`, `{"show":{"version":1,"system":{"name":"router"}}}`, `1`}
	for index, expected := range want {
		if got := string(values[index]); got != expected {
			t.Fatalf("values[%d] = %s, want %s", index, got, expected)
		}
	}
	if len(transport.bodies) != 1 || string(transport.bodies[0]) != `[{"show":{"version":{}}}]` {
		t.Fatalf("request body = %s, want one de-duplicated command", transport.bodies[0])
	}
}

func TestExecuteManyCopiesValuesFromResponseBuffer(t *testing.T) {
	body := []byte(`[{"show":{"version":1}}]`)
	client, _ := newRecordingClient(t, Response{Status: 200, Body: body}, nil)
	values, err := client.ExecuteMany(context.Background(), Q("show.version"))
	if err != nil {
		t.Fatal(err)
	}
	copy(body, []byte(`[{"show":{"version":9}}]`))
	if got, want := string(values[0]), `1`; got != want {
		t.Fatalf("value after response mutation = %s, want %s", got, want)
	}
}

func TestExecuteManyWrapsTransportError(t *testing.T) {
	underlying := errors.New("connection lost")
	client, _ := newRecordingClient(t, Response{Status: 200, Body: []byte(`[]`)}, underlying)
	values, err := client.ExecuteMany(context.Background(), Q("show.version"))
	if values != nil || !errors.Is(err, underlying) {
		t.Fatalf("ExecuteMany transport failure = (%#v, %v), want wrapped cause", values, err)
	}
}

func TestExecuteManyPreservesResponseTooLargeSentinel(t *testing.T) {
	client, _ := newRecordingClient(t, Response{}, ErrResponseTooLarge)
	values, err := client.ExecuteMany(context.Background(), Q("show.version"))
	if values != nil || !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("ExecuteMany oversized response = (%#v, %v), want ErrResponseTooLarge", values, err)
	}
}

func TestExecuteManyPreservesContextCancellation(t *testing.T) {
	client, transport := newRecordingClient(t, Response{}, context.Canceled)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	values, err := client.ExecuteMany(ctx, Q("show.version"))
	if values != nil || !errors.Is(err, context.Canceled) || len(transport.contexts) != 1 || transport.contexts[0] != ctx {
		t.Fatalf("ExecuteMany cancellation = (%#v, %v), context = %v", values, err, transport.contexts)
	}
}

func TestExecuteManyClassifiesNon200AndTruncatesBody(t *testing.T) {
	body := []byte(strings.Repeat("x", 5000))
	client, _ := newRecordingClient(t, Response{Status: 503, Body: body}, nil)
	values, err := client.ExecuteMany(context.Background(), Q("show.version"))
	var httpErr *HTTPError
	if values != nil || !errors.As(err, &httpErr) || httpErr.StatusCode != 503 || httpErr.Status != "503" || len(httpErr.Body) != 4096 {
		t.Fatalf("ExecuteMany non-200 = (%#v, %v), want HTTPError fields", values, err)
	}
}

func TestExecuteManyReturnsEmptyNonNilSliceWithoutSending(t *testing.T) {
	client, transport := newRecordingClient(t, Response{}, nil)
	values, err := client.ExecuteMany(context.Background())
	if err != nil || values == nil || len(values) != 0 || transport.calls != 0 {
		t.Fatalf("ExecuteMany() = (%#v, %v), calls = %d, want non-nil empty and no send", values, err, transport.calls)
	}
}

func TestExecuteRawReturnsBodyOnSuccessAndInvalidResponse(t *testing.T) {
	tests := []struct {
		name string
		body []byte
		err  bool
	}{
		{name: "success", body: []byte(`[{"show":{"version":1}}]`)},
		{name: "invalid response", body: []byte(`{"not":"an array"}`), err: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, _ := newRecordingClient(t, Response{Status: 200, Body: test.body}, nil)
			values, body, err := client.ExecuteRaw(context.Background(), Q("show.version"))
			if !reflect.DeepEqual(body, test.body) {
				t.Fatalf("body = %q, want exact transport body %q", body, test.body)
			}
			if test.err {
				if values != nil || !errors.Is(err, ErrInvalidResponse) {
					t.Fatalf("ExecuteRaw invalid response = (%#v, %q, %v), want nil values and ErrInvalidResponse", values, body, err)
				}
				return
			}
			if err != nil || string(values[0]) != `1` {
				t.Fatalf("ExecuteRaw success = (%#v, %q, %v), want value and body", values, body, err)
			}
		})
	}
}

func TestExecuteRawReturnsBodyOnNon200AndNilBodyOnSendError(t *testing.T) {
	responseBody := []byte(strings.Repeat("x", 5000))
	client, _ := newRecordingClient(t, Response{Status: 403, Body: responseBody}, nil)
	values, body, err := client.ExecuteRaw(context.Background(), Q("show.version"))
	var httpErr *HTTPError
	if values != nil || !reflect.DeepEqual(body, responseBody) || !errors.As(err, &httpErr) || len(httpErr.Body) != 4096 {
		t.Fatalf("ExecuteRaw non-200 = (%#v, %q, %v), want body and HTTPError", values, body, err)
	}

	underlying := errors.New("send failed")
	client, _ = newRecordingClient(t, Response{Status: 200, Body: []byte(`[]`)}, underlying)
	values, body, err = client.ExecuteRaw(context.Background(), Q("show.version"))
	if values != nil || body != nil || !errors.Is(err, underlying) {
		t.Fatalf("ExecuteRaw send error = (%#v, %q, %v), want nil values/body and wrapped error", values, body, err)
	}
}

func TestExecuteRawDropsResponseWhenSendReturnsResponseAndError(t *testing.T) {
	underlying := errors.New("partial send")
	client, _ := newRecordingClient(t, Response{Status: 200, Body: []byte(`[{"show":{"version":1}}]`)}, underlying)
	values, body, err := client.ExecuteRaw(context.Background(), Q("show.version"))
	if values != nil || body != nil || !errors.Is(err, underlying) {
		t.Fatalf("ExecuteRaw mixed send result = (%#v, %q, %v), want error to win", values, body, err)
	}
}

func TestExecuteRawReturnsNilBodyForPreSendFailuresAndZeroQueries(t *testing.T) {
	client, transport := newRecordingClient(t, Response{Status: 200, Body: []byte(`[]`)}, nil)
	values, body, err := client.ExecuteRaw(context.Background(), Q("show..version"))
	if values != nil || body != nil || !errors.Is(err, ErrInvalidPath) || transport.calls != 0 {
		t.Fatalf("ExecuteRaw invalid path = (%#v, %q, %v), calls = %d", values, body, err, transport.calls)
	}

	values, body, err = client.ExecuteRaw(context.Background(), Q("show.version", make(chan int)))
	var queryErr *QueryError
	if values != nil || body != nil || !errors.As(err, &queryErr) || transport.calls != 0 {
		t.Fatalf("ExecuteRaw marshal failure = (%#v, %q, %v), calls = %d", values, body, err, transport.calls)
	}

	values, body, err = client.ExecuteRaw(context.Background())
	if err != nil || values == nil || len(values) != 0 || body != nil || transport.calls != 0 {
		t.Fatalf("ExecuteRaw() = (%#v, %q, %v), calls = %d, want empty values/nil body/no send", values, body, err, transport.calls)
	}
}

func TestExecuteReturnsElementZero(t *testing.T) {
	client, _ := newRecordingClient(t, Response{Status: 200, Body: []byte(`[{"show":{"version":1}}]`)}, nil)
	value, err := client.Execute(context.Background(), Q("show.version"))
	if err != nil || string(value) != `1` {
		t.Fatalf("Execute = (%s, %v), want 1 and nil error", value, err)
	}
}
