package socket

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mndw.local/rcisock"
	"mndwd/internal/rcisession/proxy"
)

func TestConnectionRequiresHelloFirst(t *testing.T) {
	client, server := net.Pipe()

	defer client.Close()

	defer server.Close()

	handler := &fakeHandler{}
	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-page", Allowed: true}, handler)
	}()

	writeJSON(t, client, map[string]any{"id": 1, "target": "node-1", "method": "GET", "path": "rci/show/version"})

	var response map[string]any

	readJSON(t, client, &response)

	if response["error"] == nil {
		t.Fatalf("response = %#v, want error", response)
	}

	if err := <-done; err == nil {
		t.Fatal("ServeConnection succeeded after request-before-hello")
	}
}

func TestConnectionTimesOutBeforeHello(t *testing.T) {
	client, server := net.Pipe()

	defer client.Close()

	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{
			PluginID:    "mws-page",
			Allowed:     true,
			IdleTimeout: 25 * time.Millisecond,
		}, &fakeHandler{})
	}()

	select {
	case err := <-done:
		var networkError net.Error

		if !errors.As(err, &networkError) || !networkError.Timeout() {
			t.Fatalf("ServeConnection error = %v, want timeout", err)
		}
	case <-time.After(time.Second):
		_ = server.Close()

		<-done
		t.Fatal("ServeConnection remained blocked before hello")
	}
}

func TestConnectionHelloTargetsAndRequest(t *testing.T) {
	client, server := net.Pipe()

	defer client.Close()

	defer server.Close()

	handler := &fakeHandler{targets: []rcisock.Target{{Identity: "node-1", Name: "A", MAC: "aa:bb:cc:dd:ee:ff"}}, response: proxy.Response{Status: 200, Body: []byte(`{"ok":true}`)}}
	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-page", Allowed: true}, handler)
	}()

	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "mws-page", "proto": 1}})

	var hello map[string]any

	readJSON(t, client, &hello)

	if hello["hello"] == nil {
		t.Fatalf("hello response = %#v", hello)
	}

	writeJSON(t, client, map[string]any{"id": 1, "op": "targets"})

	var targets map[string]any

	readJSON(t, client, &targets)

	if targets["targets"] == nil || strings.Contains(string(mustJSON(targets)), "secret") {
		t.Fatalf("targets response = %#v", targets)
	}

	writeJSON(t, client, map[string]any{"id": 2, "target": "node-1", "method": "LINK", "path": "rci/show/version"})

	var response map[string]any

	readJSON(t, client, &response)

	if response["status"] != float64(200) || string(mustJSON(response["body"])) != `{"ok":true}` {
		t.Fatalf("request response = %#v", response)
	}

	client.Close()

	if err := <-done; err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.EOF) {
		t.Fatalf("ServeConnection error = %v", err)
	}
}

func TestTargetsShareMaxInflightAdmission(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	handler := &admissionHandler{
		targetsEntered: make(chan struct{}, 1),
		requestEntered: make(chan struct{}, 1),
		releaseTargets: make(chan struct{}),
	}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(handler.releaseTargets) }) }
	t.Cleanup(release)

	done := make(chan error, 1)
	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "plugin", Allowed: true, MaxInflight: 1}, handler)
	}()

	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "plugin", "proto": 1}})
	_ = readRawFrame(t, client)
	writeJSON(t, client, map[string]any{"id": 1, "op": "targets"})

	select {
	case <-handler.targetsEntered:
	case <-time.After(time.Second):
		t.Fatal("targets handler did not start")
	}

	writeJSON(t, client, map[string]any{"id": 2, "target": "node-1", "method": "GET", "path": "rci/show/version"})
	select {
	case <-handler.requestEntered:
		t.Fatal("request handler started while targets occupied MaxInflight")
	case <-time.After(100 * time.Millisecond):
	}

	release()
	var targetsResponse, requestResponse map[string]json.RawMessage
	if err := json.Unmarshal(readRawFrame(t, client), &targetsResponse); err != nil {
		t.Fatal(err)
	}
	if string(targetsResponse["id"]) != "1" || targetsResponse["targets"] == nil {
		t.Fatalf("targets response = %s", mustJSON(targetsResponse))
	}

	select {
	case <-handler.requestEntered:
	case <-time.After(time.Second):
		t.Fatal("request handler did not start after targets completed")
	}
	if err := json.Unmarshal(readRawFrame(t, client), &requestResponse); err != nil {
		t.Fatal(err)
	}
	if string(requestResponse["id"]) != "2" || requestResponse["status"] == nil {
		t.Fatalf("request response = %s", mustJSON(requestResponse))
	}

	_ = client.Close()
	if err := <-done; err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("ServeConnection error = %v", err)
	}
}

func TestClientEOFcancelsInflightHandlers(t *testing.T) {
	for _, op := range []string{"request", "targets"} {
		t.Run(op, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			handler := &cancelAwareHandler{
				entered:   make(chan struct{}, 1),
				cancelled: make(chan error, 1),
			}
			done := make(chan error, 1)
			go func() {
				done <- ServeConnection(ctx, server, Config{PluginID: "plugin", Allowed: true}, handler)
			}()

			writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "plugin", "proto": 1}})
			_ = readRawFrame(t, client)
			frame := map[string]any{"id": 1, "op": op}
			if op == "request" {
				frame = map[string]any{"id": 1, "target": "node-1", "method": "GET", "path": "rci/show/version"}
			}
			writeJSON(t, client, frame)

			select {
			case <-handler.entered:
			case <-time.After(time.Second):
				t.Fatal("handler did not start")
			}

			if err := client.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-handler.cancelled:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("handler context error = %v, want context.Canceled", err)
				}
			case <-time.After(time.Second):
				t.Fatal("handler context was not cancelled after client EOF")
			}

			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("ServeConnection did not return after client EOF")
			}
		})
	}
}

func TestConnectionReadGrantRejectsWriteFrame(t *testing.T) {
	client, server := net.Pipe()

	defer client.Close()

	defer server.Close()

	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{
			PluginID: "mws-page",
			Grants:   Grants{CanRead: true},
		}, &fakeHandler{response: proxy.Response{Status: 200, Body: []byte(`{"ok":true}`)}})
	}()

	writeJSON(t, client, map[string]any{`hello`: map[string]any{`pluginId`: `mws-page`, `proto`: 1}})

	_ = readRawFrame(t, client)

	writeJSON(t, client, map[string]any{
		`id`: 1, `target`: `node-1`, `method`: `POST`, `path`: `rci/`,
		`body`: json.RawMessage(`{"interface":{"name":"WifiMaster0","power":75}}`),
	})

	response := readRawFrame(t, client)

	if !bytes.Contains(response, []byte(`"write-not-permitted"`)) {
		t.Fatalf(`response = %s`, response)
	}

	client.Close()

	_ = <-done
}

func TestConnectionLogsRequestFailureWithoutRequestBody(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	client, server := net.Pipe()

	defer client.Close()

	defer server.Close()

	handler := &fakeHandler{requestError: proxy.ErrTargetUnreachable}
	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-page", Allowed: true, Logger: logger}, handler)
	}()

	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "mws-page", "proto": 1}})

	var hello map[string]any

	readJSON(t, client, &hello)
	writeJSON(t, client, map[string]any{
		"id":     1,
		"target": "node-1",
		"method": "POST",
		"path":   "rci/",
		"body":   `{"authentication":{"token":{"generate":{"value":"DO_NOT_LOG"}}}}`,
	})

	var response map[string]any

	readJSON(t, client, &response)
	client.Close()
	<-done

	output := logs.String()

	if !strings.Contains(output, "persistent RCI request failed") || !strings.Contains(output, "target=node-1") || !strings.Contains(output, "path=rci/") {
		t.Fatalf("request log = %s", output)
	}

	if strings.Contains(output, "DO_NOT_LOG") || strings.Contains(output, "authentication") {
		t.Fatalf("request log leaked body data: %s", output)
	}
}

func TestConnectionRejectsPermissionAndOversizeFrame(t *testing.T) {
	client, server := net.Pipe()

	defer client.Close()

	defer server.Close()

	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-page", Allowed: false}, &fakeHandler{})
	}()

	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "mws-page", "proto": 1}})

	var response map[string]any

	readJSON(t, client, &response)

	if response["error"] == nil {
		t.Fatalf("permission response = %#v", response)
	}

	if err := <-done; err == nil {
		t.Fatal("permission-denied connection stayed open")
	}

	client, server = net.Pipe()

	defer client.Close()

	defer server.Close()

	done = make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-page", Allowed: true}, &fakeHandler{})
	}()

	client.Write([]byte(`{"hello":{"pluginId":"mws-page","proto":1}}` + "\n"))
	readJSON(t, client, &response)

	oversizeWriteDone := make(chan error, 1)

	go func() {
		_, err := client.Write([]byte("{\"id\":1,\"target\":\"node-1\",\"method\":\"GET\",\"path\":\"rci/" + strings.Repeat("x", 70_000) + "\"}\n"))
		oversizeWriteDone <- err
	}()

	serveErr := <-done
	_ = client.Close()

	<-oversizeWriteDone

	if serveErr == nil {
		t.Fatal("oversize frame accepted")
	}
}

func TestErrorResponsesPreserveIDPresence(t *testing.T) {
	t.Run("hello required emits zero id", func(t *testing.T) {
		client, server := net.Pipe()

		defer client.Close()

		defer server.Close()

		done := make(chan error, 1)

		go func() {
			done <- ServeConnection(context.Background(), server, Config{PluginID: "plugin", Allowed: true}, &fakeHandler{})
		}()

		if _, err := client.Write([]byte(`{"op":"targets"}` + "\n")); err != nil {
			t.Fatal(err)
		}

		response := readRawFrame(t, client)
		var decoded map[string]json.RawMessage

		if err := json.Unmarshal(response, &decoded); err != nil {
			t.Fatal(err)
		}

		if string(decoded["id"]) != "0" {
			t.Fatalf("response = %s, want id:0", response)
		}

		if err := <-done; err == nil {
			t.Fatal("ServeConnection succeeded after request-before-hello")
		}
	})

	t.Run("rejected hello omits id", func(t *testing.T) {
		client, server := net.Pipe()

		defer client.Close()

		defer server.Close()

		done := make(chan error, 1)

		go func() {
			done <- ServeConnection(context.Background(), server, Config{PluginID: "plugin", Allowed: false}, &fakeHandler{})
		}()

		writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "plugin", "proto": 1}})

		response := readRawFrame(t, client)
		var decoded map[string]json.RawMessage

		if err := json.Unmarshal(response, &decoded); err != nil {
			t.Fatal(err)
		}

		if _, ok := decoded["id"]; ok {
			t.Fatalf("response = %s, want no id", response)
		}

		if err := <-done; err == nil {
			t.Fatal("permission-denied connection stayed open")
		}
	})

	t.Run("invalid id omits id", func(t *testing.T) {
		client, server := net.Pipe()

		defer client.Close()

		defer server.Close()

		done := make(chan error, 1)

		go func() {
			done <- ServeConnection(context.Background(), server, Config{PluginID: "plugin", Allowed: true}, &fakeHandler{})
		}()

		writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "plugin", "proto": 1}})

		_ = readRawFrame(t, client)

		writeJSON(t, client, map[string]any{"id": 0, "op": "targets"})

		response := readRawFrame(t, client)
		var decoded map[string]json.RawMessage

		if err := json.Unmarshal(response, &decoded); err != nil {
			t.Fatal(err)
		}

		if _, ok := decoded["id"]; ok {
			t.Fatalf("response = %s, want no id", response)
		}

		if err := <-done; err == nil {
			t.Fatal("invalid-id connection stayed open")
		}
	})
}

func TestEmptyTargetsResponsePreservesArray(t *testing.T) {
	client, server := net.Pipe()

	defer client.Close()

	defer server.Close()

	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "plugin", Allowed: true}, &fakeHandler{targets: []rcisock.Target{}})
	}()

	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "plugin", "proto": 1}})

	_ = readRawFrame(t, client)

	writeJSON(t, client, map[string]any{"id": 1, "op": "targets"})

	response := readRawFrame(t, client)
	var decoded map[string]json.RawMessage

	if err := json.Unmarshal(response, &decoded); err != nil {
		t.Fatal(err)
	}

	if string(decoded["targets"]) != "[]" {
		t.Fatalf("targets = %s, want []", decoded["targets"])
	}

	client.Close()

	if err := <-done; err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("ServeConnection error = %v", err)
	}
}

func TestStalledWriterHonorsWriteDeadline(t *testing.T) {
	var input bytes.Buffer

	if err := rcisock.WriteFrame(&input, rcisock.RequestFrame{Hello: &rcisock.ClientHello{PluginID: "plugin", Proto: 1}}); err != nil {
		t.Fatal(err)
	}

	if err := rcisock.WriteFrame(&input, rcisock.RequestFrame{ID: 1, Op: "request"}); err != nil {
		t.Fatal(err)
	}

	connection := newDeadlineAwareConn(input.Bytes())
	done := make(chan error, 1)

	go func() {
		done <- ServeConnection(context.Background(), connection, Config{
			PluginID:    "plugin",
			Allowed:     true,
			IdleTimeout: 20 * time.Millisecond,
		}, &fakeHandler{response: proxy.Response{Status: 200, Body: []byte(`{"ok":true}`)}})
	}()

	select {
	case <-connection.deadlineSet:
	case <-time.After(time.Second):
		t.Fatal("server did not set write deadline")
	}

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stalled writer did not return")
	}

	if connection.writeCalls.Load() < 2 {
		t.Fatalf("write calls = %d, want hello and response", connection.writeCalls.Load())
	}
}

type fakeHandler struct {
	targets      []rcisock.Target
	response     proxy.Response
	requestError error
	targetsError error
}

type admissionHandler struct {
	targetsEntered chan struct{}
	requestEntered chan struct{}
	releaseTargets chan struct{}
}

type cancelAwareHandler struct {
	entered   chan struct{}
	cancelled chan error
}

func (h *cancelAwareHandler) Do(ctx context.Context, _ proxy.Request) (proxy.Response, error) {
	h.entered <- struct{}{}
	<-ctx.Done()
	h.cancelled <- ctx.Err()
	return proxy.Response{}, ctx.Err()
}

func (h *cancelAwareHandler) Targets(ctx context.Context) ([]rcisock.Target, error) {
	h.entered <- struct{}{}
	<-ctx.Done()
	h.cancelled <- ctx.Err()
	return nil, ctx.Err()
}

func (h *admissionHandler) Do(context.Context, proxy.Request) (proxy.Response, error) {
	h.requestEntered <- struct{}{}
	return proxy.Response{Status: 200, Body: []byte(`{"ok":true}`)}, nil
}

func (h *admissionHandler) Targets(ctx context.Context) ([]rcisock.Target, error) {
	h.targetsEntered <- struct{}{}
	select {
	case <-h.releaseTargets:
		return []rcisock.Target{}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (f *fakeHandler) Do(context.Context, proxy.Request) (proxy.Response, error) {
	if f.requestError != nil {
		return proxy.Response{}, f.requestError
	}

	if f.response.Status == 0 {
		f.response = proxy.Response{Status: 200, Body: []byte(`{}`)}
	}

	return f.response, nil
}

func (f *fakeHandler) Targets(context.Context) ([]rcisock.Target, error) {
	return f.targets, f.targetsError
}

func writeJSON(t *testing.T, connection net.Conn, value any) {
	t.Helper()

	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := connection.Write(append(data, '\n')); err != nil {
		t.Fatal(err)
	}
}

func readJSON(t *testing.T, connection net.Conn, destination any) {
	t.Helper()
	connection.SetReadDeadline(time.Now().Add(2 * time.Second))

	if err := json.NewDecoder(bufio.NewReader(connection)).Decode(destination); err != nil {
		t.Fatal(err)
	}
}

func readRawFrame(t *testing.T, connection net.Conn) []byte {
	t.Helper()
	connection.SetReadDeadline(time.Now().Add(2 * time.Second))

	reader := bufio.NewReader(connection)
	frame, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}

	return bytes.TrimSuffix(frame, []byte{'\n'})
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)

	return data
}

type deadlineAwareConn struct {
	reader       *bytes.Reader
	closed       chan struct{}
	closeOnce    sync.Once
	deadlineSet  chan struct{}
	deadlineOnce sync.Once
	writeCalls   atomic.Int32
}

func newDeadlineAwareConn(data []byte) *deadlineAwareConn {
	return &deadlineAwareConn{
		reader:      bytes.NewReader(data),
		closed:      make(chan struct{}),
		deadlineSet: make(chan struct{}),
	}
}

func (c *deadlineAwareConn) Read(data []byte) (int, error) {
	return c.reader.Read(data)
}

func (c *deadlineAwareConn) Write(data []byte) (int, error) {
	call := c.writeCalls.Add(1)

	if call == 1 {
		return len(data), nil
	}

	<-c.closed

	return 0, net.ErrClosed
}

func (c *deadlineAwareConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })

	return nil
}

func (*deadlineAwareConn) LocalAddr() net.Addr             { return socketTestAddr("local") }
func (*deadlineAwareConn) RemoteAddr() net.Addr            { return socketTestAddr("remote") }
func (*deadlineAwareConn) SetDeadline(time.Time) error     { return nil }
func (*deadlineAwareConn) SetReadDeadline(time.Time) error { return nil }
func (c *deadlineAwareConn) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		c.deadlineOnce.Do(func() { close(c.deadlineSet) })
		time.AfterFunc(time.Until(deadline), func() { _ = c.Close() })
	}

	return nil
}

var _ net.Conn = (*deadlineAwareConn)(nil)

type socketTestAddr string

func (a socketTestAddr) Network() string { return "test" }
func (a socketTestAddr) String() string  { return string(a) }
