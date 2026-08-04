package persistent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

func TestClientUsesIdentityForPollingAndEmitsMacAfterTwoMisses(t *testing.T) {
	var callsMu sync.Mutex
	callCount := 0
	client := New(Config{
		PluginID:     "mws-map-page",
		PollInterval: 10 * time.Millisecond,
		RetryDelay:   10 * time.Millisecond,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()
			go serveTestConnection(t, serverConn, func(frame wireFrame) wireFrame {
				if frame.Op == "targets" {
					return wireFrame{ID: frame.ID, Targets: []Target{{Identity: "cid-1", Name: "Extender", MAC: "AA:BB:CC:DD:EE:FF"}}}
				}
				callsMu.Lock()
				callCount++
				current := callCount
				callsMu.Unlock()
				if frame.Target != "cid-1" || frame.Method != "GET" || frame.Path != "rci/show/version" {
					return wireFrame{ID: frame.ID, Error: &wireError{Code: "bad-request", Message: "bad poll"}}
				}
				if current == 1 {
					return wireFrame{ID: frame.ID, Status: 200, Body: json.RawMessage(`{}`)}
				}
				return wireFrame{ID: frame.ID, Error: &wireError{Code: "target-unreachable", Message: "target-unreachable"}}
			})
			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go client.Run(ctx)

	waitFor(t, func() bool {
		sessions := client.Snapshot()
		return len(sessions) == 1 && sessions[0].Mac == "aa:bb:cc:dd:ee:ff" && sessions[0].Live
	})
	waitFor(t, func() bool {
		sessions := client.Snapshot()
		return len(sessions) == 1 && sessions[0].Mac == "aa:bb:cc:dd:ee:ff" && !sessions[0].Live
	})
	cancel()
}

func TestClientClearsStateWhenSocketCloses(t *testing.T) {
	var attemptsMu sync.Mutex
	attempts := 0
	client := New(Config{
		PluginID:     "mws-map-page",
		PollInterval: 10 * time.Millisecond,
		RetryDelay:   10 * time.Millisecond,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()
			attemptsMu.Lock()
			attempts++
			attempt := attempts
			attemptsMu.Unlock()
			go serveTestConnection(t, serverConn, func(frame wireFrame) wireFrame {
				if attempt == 1 && frame.Op == "targets" {
					return wireFrame{ID: frame.ID, Targets: []Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}
				if attempt == 1 {
					return wireFrame{ID: frame.ID, Status: 200, Body: json.RawMessage(`{}`)}
				}
				return wireFrame{ID: frame.ID, Error: &wireError{Code: "not-permitted", Message: "not-permitted"}}
			})
			if attempt == 1 {
				go func() {
					time.Sleep(20 * time.Millisecond)
					_ = serverConn.Close()
				}()
			}
			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go client.Run(ctx)

	waitFor(t, func() bool { return len(client.Snapshot()) == 1 })
	waitFor(t, func() bool { return len(client.Snapshot()) == 0 })
	cancel()
}

func TestClientTreatsUnavailableSocketAsEmpty(t *testing.T) {
	client := New(Config{Dial: func(context.Context) (net.Conn, error) {
		return nil, errors.New("socket absent")
	}, RetryDelay: 5 * time.Millisecond})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	client.Run(ctx)
	if sessions := client.Snapshot(); len(sessions) != 0 {
		t.Fatalf("sessions = %#v, want empty", sessions)
	}
}

func TestClientRequiresTwoConsecutiveFailuresBeforeFalse(t *testing.T) {
	client := New(Config{PluginID: "mws-map-page"})
	target := Target{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}
	if err := client.updateTargets([]Target{target}); err != nil {
		t.Fatal(err)
	}

	client.applyResult(target, wireFrame{}, &remoteError{code: "target-unreachable"})
	if sessions := client.Snapshot(); len(sessions) != 0 {
		t.Fatalf("after one miss sessions = %#v, want empty", sessions)
	}

	client.applyResult(target, wireFrame{}, &remoteError{code: "target-unreachable"})
	if sessions := client.Snapshot(); len(sessions) != 1 || sessions[0] != (Session{Mac: target.MAC, Live: false}) {
		t.Fatalf("after two misses sessions = %#v, want configured failure", sessions)
	}
}

func serveTestConnection(t *testing.T, connection net.Conn, respond func(wireFrame) wireFrame) {
	t.Helper()
	defer connection.Close()
	reader := bufio.NewReader(connection)
	var hello wireFrame
	if err := json.NewDecoder(reader).Decode(&hello); err != nil {
		return
	}
	if hello.Hello == nil || hello.Hello.PluginID != "mws-map-page" || hello.Hello.Proto != 1 {
		t.Errorf("hello = %#v, want mws-map-page protocol 1", hello.Hello)
		return
	}
	if _, err := connection.Write([]byte(`{"hello":{"proto":1,"ok":true}}
`)); err != nil {
		return
	}
	for {
		var frame wireFrame
		if err := json.NewDecoder(reader).Decode(&frame); err != nil {
			return
		}
		response := respond(frame)
		data, err := json.Marshal(response)
		if err != nil {
			return
		}
		if _, err := connection.Write(append(data, '\n')); err != nil {
			return
		}
	}
}

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
