package persistent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"mndw.local/rcisock"
)

func TestClientSendReturnsRawResponseAndRejectsUnknownTarget(t *testing.T) {
	client := New(Config{PluginID: "mws-page"})

	if _, err := client.Send(context.Background(), "cid-1", Request{Method: "POST", Path: "rci/"}); !errors.Is(err, ErrNoSession) {
		t.Fatalf("Send without session error = %v", err)
	}

	if err := client.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	if _, err := client.Send(context.Background(), "churny-unknown", Request{Method: "POST", Path: "rci/"}); !errors.Is(err, ErrNoSession) {
		t.Fatalf("Send unknown target error = %v", err)
	}

	if len(client.store.locks) != 1 {
		t.Fatalf("target locks = %d, want one admitted identity", len(client.store.locks))
	}

	ready := make(chan struct{}, 1)
	client.config.Dial = func(context.Context) (net.Conn, error) {
		clientConn, serverConn := net.Pipe()

		go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
			if frame.Op == "targets" {
				select {
				case ready <- struct{}{}:
				default:
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}}
			}

			if frame.Method == "POST" {
				return rcisock.ResponseFrame{ID: responseID(frame), Status: 207, Body: json.RawMessage(`{"raw":true}`)}
			}

			return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
		})

		return clientConn, nil
	}
	client.config.PollInterval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("target enumeration did not complete")
	}

	waitFor(t, func() bool { return client.HasTarget("cid-1") })

	response, err := client.Send(context.Background(), "cid-1", Request{Method: "POST", Path: "rci/", Body: []byte(`{}`)})
	if err != nil {
		t.Fatal(err)
	}

	if response.Status != 207 || string(response.Body) != `{"raw":true}` {
		t.Fatalf("response = %#v", response)
	}
}

func TestClientUsesIdentityForPollingAndEmitsMacAfterTwoMisses(t *testing.T) {
	var callsMu sync.Mutex
	callCount := 0
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: 10 * time.Millisecond,
		RetryDelay:   10 * time.Millisecond,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "AA:BB:CC:DD:EE:FF"}}}
				}

				callsMu.Lock()

				callCount++
				current := callCount

				callsMu.Unlock()

				if frame.Target != "cid-1" || frame.Method != "GET" || frame.Path != "rci/show/version" {
					return rcisock.ResponseFrame{ID: responseID(frame), Error: &rcisock.Error{Code: "bad-request", Message: "bad poll"}}
				}

				if current == 1 {
					return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Error: &rcisock.Error{Code: "target-unreachable", Message: "target-unreachable"}}
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

func TestClientSendKeepsRPCAliveAfterCallerCancellation(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseResponse := make(chan struct{})
	rpc := newTestRPC(t, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
		close(requestStarted)
		<-releaseResponse

		return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{"ok":true}`)}
	})

	defer rpc.Close()

	client := New(Config{PluginID: "mws-page", IOTimeout: time.Second})

	if err := client.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	client.dispatch.setRPC(rpc)

	ctx, cancel := context.WithCancel(context.Background())
	responseCh := make(chan struct {
		response Response
		err      error
	}, 1)

	go func() {
		response, err := client.Send(ctx, "cid-1", Request{Method: "POST", Path: "rci/"})
		responseCh <- struct {
			response Response
			err      error
		}{response: response, err: err}
	}()

	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("RPC request did not start")
	}

	cancel()
	close(releaseResponse)

	select {
	case result := <-responseCh:
		if result.err != nil || result.response.Status != 200 || string(result.response.Body) != `{"ok":true}` {
			t.Fatalf("Send result = %#v, err = %v", result.response, result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("Send did not finish after RPC response")
	}
}

func TestClientPollTargetsPropagatesContextCancellationToRPC(t *testing.T) {
	requestStarted := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	rpc := newTestRPC(t, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
		close(requestStarted)
		<-ctx.Done()

		return rcisock.ResponseFrame{ID: responseID(frame), Status: 200}
	})

	defer rpc.Close()

	client := New(Config{PluginID: "mws-page"})

	if err := client.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)

	go func() { done <- client.pollTargets(ctx, rpc) }()

	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("poll request did not start")
	}

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("pollTargets did not stop after cancellation")
	}
}

func TestClientSnapshotUsesVisibilityPredicateAndMacOrdering(t *testing.T) {
	client := New(Config{PluginID: "mws-page"})
	now := time.Now().UTC()
	client.store.records = map[string]targetRecord{
		"live":  {target: Target{Identity: "live", MAC: "cc:cc:cc:cc:cc:cc"}, session: &sessionState{live: true, lastSeenAt: now}},
		"miss1": {target: Target{Identity: "miss1", MAC: "dd:dd:dd:dd:dd:dd"}, session: &sessionState{misses: 1, lastSeenAt: now}},
		"miss2": {target: Target{Identity: "miss2", MAC: "aa:aa:aa:aa:aa:aa"}, session: &sessionState{misses: 2, lastSeenAt: now}},
	}

	sessions := client.Snapshot()

	if len(sessions) != 2 {
		t.Fatalf("sessions = %#v, want live and two-miss sessions", sessions)
	}

	if sessions[0].Identity != "miss2" || sessions[0].Live || sessions[1].Identity != "live" || !sessions[1].Live {
		t.Fatalf("sessions = %#v, want MAC order with one-miss session omitted", sessions)
	}
}

func TestClientRetainsStateWhenSocketCloses(t *testing.T) {
	var attemptsMu sync.Mutex
	attempts := 0
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: 10 * time.Millisecond,
		RetryDelay:   10 * time.Millisecond,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			attemptsMu.Lock()

			attempts++
			attempt := attempts

			attemptsMu.Unlock()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if attempt == 1 && frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				if attempt == 1 {
					return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Error: &rcisock.Error{Code: "not-permitted", Message: "not-permitted"}}
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
	waitFor(t, func() bool {
		sessions := client.Snapshot()

		return len(sessions) == 1 && !sessions[0].Live
	})
	cancel()
}

func TestClientReconnectsAfterServerRestart(t *testing.T) {
	var attemptsMu sync.Mutex
	attempts := 0
	firstTargets := make(chan struct{}, 1)
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: 5 * time.Millisecond,
		RetryDelay:   5 * time.Millisecond,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			attemptsMu.Lock()

			attempts++
			attempt := attempts

			attemptsMu.Unlock()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					if attempt == 1 {
						select {
						case firstTargets <- struct{}{}:
						default:
						}
					}

					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
			})

			if attempt == 1 {
				go func() {
					<-firstTargets
					time.Sleep(time.Millisecond)

					_ = serverConn.Close()
				}()
			}

			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	waitFor(t, func() bool {
		diagnostics := client.Diagnostics()

		return diagnostics.ConnectionAttempts >= 2 && diagnostics.ReconnectCount >= 1 && diagnostics.Connected && diagnostics.TargetCount == 1 && diagnostics.SessionCount == 1
	})

	if sessions := client.Snapshot(); len(sessions) != 1 || !sessions[0].Live {
		t.Fatalf("sessions after reconnect = %#v, want one live session", sessions)
	}
}

func TestClientBoundsStalledTelemetryRequest(t *testing.T) {
	telemetryFinished := make(chan error, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseConnection := func() {
		releaseOnce.Do(func() { close(release) })
	}

	defer releaseConnection()

	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		IOTimeout:    20 * time.Millisecond,
		RetryDelay:   5 * time.Millisecond,
		TelemetryPoll: func(ctx context.Context, target Target, requester Requester) error {
			_, err := requester.Do(ctx, Request{Method: "POST", Path: "rci/", Body: []byte(`{"query":"cpu"}`)})
			telemetryFinished <- err

			return err
		},
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				if frame.Method == "GET" && frame.Path == "rci/show/version" {
					return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
				}

				<-release

				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
			})

			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	select {
	case err := <-telemetryFinished:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("telemetry error = %v, want deadline exceeded", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("stalled telemetry request was not bounded")
	}

	waitFor(t, func() bool { return client.Diagnostics().ConnectionAttempts >= 2 })
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

func TestClientDiagnosticsReportsSocketDialFailure(t *testing.T) {
	client := New(Config{
		PluginID: "mws-page",
		Path:     "/run/mws-page/rci-session.sock",
		Dial: func(context.Context) (net.Conn, error) {
			return nil, errors.New("socket absent")
		},
		RetryDelay: 5 * time.Millisecond,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)

	defer cancel()

	client.Run(ctx)

	diagnostics := client.Diagnostics()

	if !diagnostics.PluginIDPresent || diagnostics.SocketPath != "/run/mws-page/rci-session.sock" {
		t.Fatalf("configuration diagnostics = %#v", diagnostics)
	}

	if diagnostics.Connected || diagnostics.TargetCount != 0 || diagnostics.SessionCount != 0 {
		t.Fatalf("connection diagnostics = %#v", diagnostics)
	}

	if diagnostics.LastError == nil || diagnostics.LastError.Phase != "connection" || diagnostics.LastError.Code != "socket-unavailable" {
		t.Fatalf("last error = %#v", diagnostics.LastError)
	}

	encoded, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(encoded), "socket absent") {
		t.Fatalf("diagnostics leaked transport error: %s", encoded)
	}
}

func TestClientDiagnosticsReportsTargetProbeFailure(t *testing.T) {
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Error: &rcisock.Error{Code: "target-unreachable", Message: "target-unreachable"}}
			})

			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	waitFor(t, func() bool {
		diagnostics := client.Diagnostics()

		return diagnostics.LastError != nil && diagnostics.LastError.Phase == "target-probe"
	})

	diagnostics := client.Diagnostics()

	if !diagnostics.Connected || diagnostics.TargetCount != 1 || diagnostics.SessionCount != 0 {
		t.Fatalf("target diagnostics = %#v", diagnostics)
	}

	if diagnostics.LastError.Identity != "cid-1" || diagnostics.LastError.Code != "target-unreachable" {
		t.Fatalf("last error = %#v", diagnostics.LastError)
	}
}

func TestClientDiagnosticsReportsTelemetryFailure(t *testing.T) {
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		TelemetryPoll: func(context.Context, Target, Requester) error {
			return errors.New("response parse failed")
		},
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
			})

			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	waitFor(t, func() bool {
		diagnostics := client.Diagnostics()

		return diagnostics.LastError != nil && diagnostics.LastError.Phase == "telemetry"
	})

	diagnostics := client.Diagnostics()

	if diagnostics.TargetCount != 1 || diagnostics.SessionCount != 1 || diagnostics.LastTelemetryAt != nil {
		t.Fatalf("telemetry diagnostics = %#v", diagnostics)
	}

	if diagnostics.LastError.Identity != "cid-1" || diagnostics.LastError.Code != "telemetry-failed" {
		t.Fatalf("last error = %#v", diagnostics.LastError)
	}

	encoded, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(encoded), "response parse failed") {
		t.Fatalf("diagnostics leaked telemetry error: %s", encoded)
	}
}

func TestClientDiagnosticsTracksTargetLifecycleDetails(t *testing.T) {
	client := New(Config{PluginID: "mws-page"})
	working := Target{Identity: "cid-1", Name: "Working", MAC: "aa:bb:cc:dd:ee:ff"}
	missing := Target{Identity: "cid-2", Name: "Missing", MAC: "11:22:33:44:55:66"}

	if err := client.updateTargets([]Target{working, missing}); err != nil {
		t.Fatal(err)
	}

	client.applyResult(working, rcisock.ResponseFrame{Status: 200}, nil)
	client.applyResult(missing, rcisock.ResponseFrame{}, &rcisock.RemoteError{Code: "no-session-for-target"})

	diagnostics := client.Diagnostics()
	encoded, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}

	var state map[string]any

	if err := json.Unmarshal(encoded, &state); err != nil {
		t.Fatal(err)
	}

	targets, ok := state["targets"].([]any)

	if !ok || len(targets) != 2 {
		t.Fatalf("targets = %#v, want two target diagnostics", state["targets"])
	}

	workingState := targetDiagnosticMap(t, targets, "cid-1")

	if workingState["present"] != true || workingState["sessionPresent"] != true || workingState["live"] != true || workingState["lastProbeStatus"] != float64(200) {
		t.Fatalf("working target diagnostics = %#v", workingState)
	}

	missingState := targetDiagnosticMap(t, targets, "cid-2")

	if missingState["present"] != true || missingState["sessionPresent"] != false || missingState["sessionReason"] != "evicted:no-session-for-target" {
		t.Fatalf("missing target diagnostics = %#v", missingState)
	}

	client.clear()

	diagnostics = client.Diagnostics()
	encoded, err = json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}

	if err := json.Unmarshal(encoded, &state); err != nil {
		t.Fatal(err)
	}

	workingState = targetDiagnosticMap(t, state["targets"].([]any), "cid-1")

	if workingState["present"] != false || workingState["sessionPresent"] != false || workingState["sessionReason"] != "connection-reset" {
		t.Fatalf("reset target diagnostics = %#v", workingState)
	}

	change, ok := state["lastTargetChange"].(map[string]any)

	if !ok || change["reason"] != "connection-reset" {
		t.Fatalf("last target change = %#v", state["lastTargetChange"])
	}
}

func TestClientDiagnosticsTracksConnectionLifecycle(t *testing.T) {
	client := New(Config{
		PluginID:   "mws-page",
		RetryDelay: 5 * time.Millisecond,
		Dial: func(context.Context) (net.Conn, error) {
			return nil, errors.New("socket absent")
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)

	defer cancel()

	client.Run(ctx)

	diagnostics := client.Diagnostics()

	if diagnostics.ConnectionAttempts == 0 || diagnostics.LastDisconnectedAt == nil || diagnostics.LastDisconnectReason == "" {
		t.Fatalf("connection lifecycle diagnostics = %#v", diagnostics)
	}
}

func TestClientDiagnosticsTracksTelemetryPhases(t *testing.T) {
	client := New(Config{PluginID: "mws-page"})
	target := Target{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}

	if err := client.updateTargets([]Target{target}); err != nil {
		t.Fatal(err)
	}

	client.RecordTelemetryPhase(target.Identity, "cpuRrd", 503, errors.New("secret transport detail"))
	client.RecordTelemetryPhase(target.Identity, "memoryRrd", 200, nil)

	diagnostics := client.Diagnostics()
	encoded, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(encoded), "secret transport detail") {
		t.Fatalf("diagnostics leaked telemetry error: %s", encoded)
	}

	var state map[string]any

	if err := json.Unmarshal(encoded, &state); err != nil {
		t.Fatal(err)
	}

	targetState := targetDiagnosticMap(t, state["targets"].([]any), target.Identity)
	telemetryState, ok := targetState["telemetry"].(map[string]any)

	if !ok {
		t.Fatalf("telemetry diagnostics = %#v", targetState["telemetry"])
	}

	cpu, ok := telemetryState["cpuRrd"].(map[string]any)

	if !ok || cpu["lastError"] == nil || cpu["lastAttemptAt"] == nil {
		t.Fatalf("cpu telemetry diagnostics = %#v", telemetryState["cpuRrd"])
	}

	memory, ok := telemetryState["memoryRrd"].(map[string]any)

	if !ok || memory["lastSuccessAt"] == nil || memory["lastError"] != nil {
		t.Fatalf("memory telemetry diagnostics = %#v", telemetryState["memoryRrd"])
	}
}

func TestClientRequiresTwoConsecutiveFailuresBeforeFalse(t *testing.T) {
	client := New(Config{PluginID: "mws-page"})
	target := Target{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}

	if err := client.updateTargets([]Target{target}); err != nil {
		t.Fatal(err)
	}

	client.applyResult(target, rcisock.ResponseFrame{}, &rcisock.RemoteError{Code: "target-unreachable"})

	if sessions := client.Snapshot(); len(sessions) != 0 {
		t.Fatalf("after one miss sessions = %#v, want empty", sessions)
	}

	client.applyResult(target, rcisock.ResponseFrame{}, &rcisock.RemoteError{Code: "target-unreachable"})

	if sessions := client.Snapshot(); len(sessions) != 1 || sessions[0] != (Session{Identity: target.Identity, Mac: target.MAC, Live: false}) {
		t.Fatalf("after two misses sessions = %#v, want configured failure", sessions)
	}
}

func TestClientRetainsLastKnownSessionDuringConnectionReset(t *testing.T) {
	client := New(Config{PluginID: "mws-page", SessionRetention: time.Minute})
	target := Target{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}

	if err := client.updateTargets([]Target{target}); err != nil {
		t.Fatal(err)
	}

	client.applyResult(target, rcisock.ResponseFrame{Status: 200}, nil)

	client.markDisconnected("connection-reset")

	sessions := client.Snapshot()

	if len(sessions) != 1 || sessions[0].Identity != target.Identity || sessions[0].Mac != target.MAC || sessions[0].Live {
		t.Fatalf("sessions during reconnect = %#v, want one non-live retained session", sessions)
	}
}

func TestClientExpiresRetainedSessionAfterConnectionRetention(t *testing.T) {
	client := New(Config{PluginID: "mws-page", SessionRetention: time.Minute})
	target := Target{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}

	if err := client.updateTargets([]Target{target}); err != nil {
		t.Fatal(err)
	}

	client.mu.Lock()

	record := client.store.records[target.Identity]
	record.session.lastSeenAt = time.Now().UTC().Add(-2 * time.Minute)
	client.store.records[target.Identity] = record

	client.mu.Unlock()

	if sessions := client.Snapshot(); len(sessions) != 0 {
		t.Fatalf("expired sessions = %#v, want empty", sessions)
	}
}

func TestClientRunsTelemetryPollThroughAuthenticatedRequester(t *testing.T) {
	requests := make(chan Request, 3)
	polled := make(chan struct{})
	var pollOnce sync.Once
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		TelemetryPoll: func(ctx context.Context, target Target, requester Requester) error {
			if target.Identity != "cid-1" {
				t.Fatalf("target = %#v", target)
			}

			for _, request := range []Request{
				{Method: "POST", Path: "rci/", Body: []byte(`{"query":"system"}`)},
				{Method: "POST", Path: "rci/", Body: []byte(`{"query":"cpu"}`)},
				{Method: "POST", Path: "rci/", Body: []byte(`{"query":"memory"}`)},
			} {
				response, err := requester.Do(ctx, request)
				if err != nil || response.Status != 200 {
					t.Fatalf("telemetry response = %#v, err = %v", response, err)
				}
			}

			pollOnce.Do(func() { close(polled) })

			return nil
		},
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				if frame.Target != "cid-1" {
					t.Errorf("telemetry target = %q, want cid-1", frame.Target)
				}

				if frame.Method == "GET" && frame.Path == "rci/show/version" {
					return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
				}

				requests <- Request{Method: frame.Method, Path: frame.Path, Body: append([]byte(nil), frame.Body...)}

				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
			})

			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	select {
	case <-polled:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("telemetry poll did not run")
	}

	for index, want := range []string{"{\"query\":\"system\"}", "{\"query\":\"cpu\"}", "{\"query\":\"memory\"}"} {
		select {
		case request := <-requests:
			if request.Method != "POST" || request.Path != "rci/" || string(request.Body) != want {
				t.Fatalf("request %d = %#v, want POST rci/ %s", index, request, want)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatalf("request %d missing", index)
		}
	}

	diagnostics := client.Diagnostics()

	if !diagnostics.Connected || diagnostics.TargetCount != 1 || diagnostics.SessionCount != 1 || diagnostics.LastTelemetryAt == nil {
		t.Fatalf("successful telemetry diagnostics = %#v", diagnostics)
	}
}

func TestClientPollsBothInterfacePowersWithoutTelemetryPoll(t *testing.T) {
	requestBody := make(chan []byte, 1)
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		Dial: func(context.Context) (net.Conn, error) {
			clientConn, serverConn := net.Pipe()

			go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
				if frame.Op == "targets" {
					return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
				}

				if frame.Method == "GET" && frame.Path == "rci/show/version" {
					return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
				}

				if frame.Method == "POST" && frame.Path == "rci/" {
					requestBody <- append([]byte(nil), frame.Body...)

					return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: interfacePowerResponse()}
				}

				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
			})

			return clientConn, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	select {
	case body := <-requestBody:
		assertInterfacePowerRequest(t, body)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("interface power request did not run without telemetry poll")
	}

	waitFor(t, func() bool {
		sessions := client.Snapshot()

		return len(sessions) == 1 && sessions[0].Power2G.Available && sessions[0].Power5G.Available &&
			sessions[0].Power2G.Value != nil && *sessions[0].Power2G.Value == 75 &&
			sessions[0].Power5G.Value != nil && *sessions[0].Power5G.Value == 100
	})
}

func TestClientPowerReadFailureDoesNotAffectTelemetry(t *testing.T) {
	telemetryDone := make(chan struct{}, 1)
	powerAttempt := make(chan struct{}, 1)
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		TelemetryPoll: func(ctx context.Context, _ Target, requester Requester) error {
			response, err := requester.Do(ctx, Request{Method: "POST", Path: "rci/", Body: []byte(`{"telemetry":true}`)})
			if err != nil || response.Status != 200 {
				return errors.New("telemetry request failed")
			}

			telemetryDone <- struct{}{}

			return nil
		},
		Dial: powerTestDial(t, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
			if frame.Method == "POST" && frame.Path == "rci/" && string(frame.Body) != `{"telemetry":true}` {
				powerAttempt <- struct{}{}

				return rcisock.ResponseFrame{ID: responseID(frame), Error: &rcisock.Error{Code: "power-failed", Message: "power-failed"}}
			}

			return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
		}),
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	select {
	case <-telemetryDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("telemetry poll did not succeed")
	}

	select {
	case <-powerAttempt:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("power poll did not run")
	}

	waitFor(t, func() bool {
		diagnostics := client.Diagnostics()

		return diagnostics.LastTelemetryAt != nil && diagnostics.ConnectionAttempts == 1 && diagnostics.LastError == nil
	})
}

func TestClientPollsPowerAfterTelemetryFailure(t *testing.T) {
	powerAttempt := make(chan struct{}, 1)
	client := New(Config{
		PluginID:     "mws-page",
		PollInterval: time.Hour,
		TelemetryPoll: func(context.Context, Target, Requester) error {
			return errors.New("telemetry failed")
		},
		Dial: powerTestDial(t, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
			if frame.Method == "POST" && frame.Path == "rci/" {
				powerAttempt <- struct{}{}

				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: interfacePowerResponse()}
			}

			return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
		}),
	})

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go client.Run(ctx)

	select {
	case <-powerAttempt:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("power poll did not run after telemetry failure")
	}
}

func powerTestDial(t *testing.T, respond func(rcisock.RequestFrame) rcisock.ResponseFrame) func(context.Context) (net.Conn, error) {
	t.Helper()

	return func(context.Context) (net.Conn, error) {
		clientConn, serverConn := net.Pipe()

		go serveTestConnection(t, serverConn, func(frame rcisock.RequestFrame) rcisock.ResponseFrame {
			if frame.Op == "targets" {
				return rcisock.ResponseFrame{ID: responseID(frame), Targets: []rcisock.Target{{Identity: "cid-1", Name: "Extender", MAC: "aa:bb:cc:dd:ee:ff"}}}
			}

			if frame.Method == "GET" && frame.Path == "rci/show/version" {
				return rcisock.ResponseFrame{ID: responseID(frame), Status: 200, Body: json.RawMessage(`{}`)}
			}

			return respond(frame)
		})

		return clientConn, nil
	}
}

func interfacePowerResponse() json.RawMessage {
	return json.RawMessage(`[
		{"show":{"sc":{"interface":{"WifiMaster0":{"power":"75"}}}}},
		{"show":{"sc":{"interface":{"WifiMaster1":{}}}}}
	]`)
}

func assertInterfacePowerRequest(t *testing.T, body []byte) {
	t.Helper()

	var queries []map[string]any

	if err := json.Unmarshal(body, &queries); err != nil {
		t.Fatalf("power request body = %s: %v", body, err)
	}

	if len(queries) != 2 {
		t.Fatalf("power query count = %d, want 2", len(queries))
	}

	for index, name := range []string{"WifiMaster0", "WifiMaster1"} {
		show, ok := queries[index]["show"].(map[string]any)

		if !ok {
			t.Fatalf("query %d show = %#v", index, queries[index]["show"])
		}

		sc, ok := show["sc"].(map[string]any)

		if !ok {
			t.Fatalf("query %d sc = %#v", index, show["sc"])
		}

		interfaceQuery, ok := sc["interface"].(map[string]any)

		if !ok || interfaceQuery["name"] != name {
			t.Fatalf("query %d interface = %#v, want name %s", index, sc["interface"], name)
		}
	}
}

func serveTestConnection(t *testing.T, connection net.Conn, respond func(rcisock.RequestFrame) rcisock.ResponseFrame) {
	t.Helper()

	defer connection.Close()

	reader := rcisock.NewReader[rcisock.RequestFrame](connection, 64<<10)
	hello, err := reader.Next()
	if err != nil {
		return
	}

	if hello.Hello == nil || hello.Hello.PluginID != "mws-page" || hello.Hello.Proto != 1 {
		t.Errorf("hello = %#v, want mws-page protocol 1", hello.Hello)

		return
	}

	if err := rcisock.WriteFrame(connection, rcisock.ResponseFrame{Hello: &rcisock.ServerHello{Proto: rcisock.ProtocolVersion, OK: true}}); err != nil {
		return
	}

	for {
		frame, err := reader.Next()
		if err != nil {
			return
		}

		response := respond(frame)

		if err := rcisock.WriteFrame(connection, response); err != nil {
			return
		}
	}
}

func newTestRPC(t *testing.T, respond func(rcisock.RequestFrame) rcisock.ResponseFrame) *rcisock.Client {
	t.Helper()

	clientConn, serverConn := net.Pipe()

	go serveTestConnection(t, serverConn, respond)

	rpc := rcisock.NewClient(clientConn, rcisock.WithIOTimeout(time.Second), rcisock.WithHandshakeTimeout(time.Second))

	if err := rpc.Handshake(context.Background(), rcisock.ClientHello{PluginID: "mws-page", Proto: rcisock.ProtocolVersion}); err != nil {
		rpc.Close()
		t.Fatalf("test RPC handshake: %v", err)
	}

	return rpc
}

func responseID(frame rcisock.RequestFrame) *int64 {
	id := frame.ID

	return &id
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

func targetDiagnosticMap(t *testing.T, targets []any, identity string) map[string]any {
	t.Helper()

	for _, item := range targets {
		target, ok := item.(map[string]any)

		if ok && target["identity"] == identity {
			return target
		}
	}

	t.Fatalf("target %q not found in %#v", identity, targets)

	return nil
}
