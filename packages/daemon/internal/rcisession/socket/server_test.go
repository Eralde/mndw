package socket

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"mndwd/internal/rcisession/proxy"
)

func TestConnectionRequiresHelloFirst(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	handler := &fakeHandler{}
	done := make(chan error, 1)
	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-map-page", Allowed: true}, handler)
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
			PluginID:    "mws-map-page",
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
	handler := &fakeHandler{targets: []TargetSummary{{Identity: "node-1", Name: "A", MAC: "aa:bb:cc:dd:ee:ff"}}, response: proxy.Response{Status: 200, Body: []byte(`{"ok":true}`)}}
	done := make(chan error, 1)
	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-map-page", Allowed: true}, handler)
	}()

	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "mws-map-page", "proto": 1}})
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

func TestConnectionRejectsPermissionAndOversizeFrame(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-map-page", Allowed: false}, &fakeHandler{})
	}()
	writeJSON(t, client, map[string]any{"hello": map[string]any{"pluginId": "mws-map-page", "proto": 1}})
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
		done <- ServeConnection(context.Background(), server, Config{PluginID: "mws-map-page", Allowed: true}, &fakeHandler{})
	}()
	client.Write([]byte(`{"hello":{"pluginId":"mws-map-page","proto":1}}` + "\n"))
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

type fakeHandler struct {
	targets  []TargetSummary
	response proxy.Response
}

func (f *fakeHandler) Do(context.Context, proxy.Request) (proxy.Response, error) {
	if f.response.Status == 0 {
		f.response = proxy.Response{Status: 200, Body: []byte(`{}`)}
	}
	return f.response, nil
}

func (f *fakeHandler) Targets(context.Context) ([]TargetSummary, error) { return f.targets, nil }

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

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}
