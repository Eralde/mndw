package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestValidate(t *testing.T) {
	valid := []string{"example.net", "192.0.2.1", "2001:db8::1"}

	for _, host := range valid {
		t.Run(host, func(t *testing.T) {
			request := validRequest(host)

			if err := request.Validate(); err != nil {
				t.Fatalf("Validate() error = %v", err)
			}
		})
	}

	invalid := []struct {
		name string
		edit func(*Request)
	}{
		{name: "empty host", edit: func(request *Request) { request.Host = "" }},
		{name: "shell text", edit: func(request *Request) { request.Host = "; rm -rf /" }},
		{name: "URL", edit: func(request *Request) { request.Host = "http://x" }},
		{name: "long host", edit: func(request *Request) { request.Host = strings.Repeat("a", 254) }},
		{name: "port zero", edit: func(request *Request) { request.PortFrom = 0 }},
		{name: "port too high", edit: func(request *Request) { request.PortTo = 65536 }},
		{name: "reversed range", edit: func(request *Request) { request.PortFrom = 5202; request.PortTo = 5201 }},
		{name: "duration too short", edit: func(request *Request) { request.Duration = 4 }},
		{name: "duration too long", edit: func(request *Request) { request.Duration = 60 }},
		{name: "streams too few", edit: func(request *Request) { request.Streams = 0 }},
		{name: "streams too many", edit: func(request *Request) { request.Streams = 9 }},
	}

	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			request := validRequest("example.net")

			test.edit(&request)

			if err := request.Validate(); err == nil {
				t.Fatal("Validate() returned no error")
			}
		})
	}
}

func TestMessageForUnknownErrorLogsOneLine(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	originalStderr := os.Stderr
	os.Stderr = writer
	message := MessageForError(errors.New("first line\nsecond line"))
	os.Stderr = originalStderr

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	logged, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}

	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}

	if string(logged) != "first line second line\n" {
		t.Fatalf("stderr = %q, want one-line underlying error", logged)
	}

	if message.Code != "iperf-failed" || message.Message != "The speed test failed" {
		t.Fatalf("MessageForError() = %#v, want generic iperf-failed message", message)
	}
}

func TestRunSequence(t *testing.T) {
	manager := newTestManager(t)
	listener, host, port := listenForProbe(t)

	defer listener.Close()

	var messages []Message
	err := manager.Run(context.Background(), Request{Host: host, PortFrom: port, PortTo: port, Duration: 5, Streams: 2}, func(value any) {
		messages = append(messages, value.(Message))
	})
	if err != nil {
		t.Fatal(err)
	}

	index := 0

	for _, phase := range []string{"download", "upload"} {
		if messages[index].Type != "phase" || messages[index].Phase != phase {
			t.Fatalf("message %d = %#v, want %s phase", index, messages[index], phase)
		}

		index++

		intervals := 0

		for index < len(messages) && messages[index].Type == "interval" {
			if messages[index].Phase != phase || messages[index].BitsPerSecond <= 0 {
				t.Fatalf("message %d = %#v, want positive %s interval", index, messages[index], phase)
			}

			intervals++
			index++
		}

		if intervals == 0 {
			t.Fatalf("%s phase has no interval messages: %#v", phase, messages)
		}

		if messages[index].Type != "result" || messages[index].Phase != phase || messages[index].BitsPerSecond <= 0 {
			t.Fatalf("message %d = %#v, want %s result", index, messages[index], phase)
		}

		index++
	}

	if messages[index].Type != "phase" || messages[index].Phase != "ping" || messages[index].Port != port {
		t.Fatalf("message %d = %#v, want ping phase on port %d", index, messages[index], port)
	}

	index++

	for sampleIndex := 0; sampleIndex < 10; sampleIndex++ {
		message := messages[index]

		if message.Type != "pingSample" || message.Index != sampleIndex || message.MS == nil {
			t.Fatalf("message %d = %#v, want successful ping sample %d", index, message, sampleIndex)
		}

		index++
	}

	if messages[index].Type != "ping" {
		t.Fatalf("message %d = %#v, want successful ping summary after samples", index, messages[index])
	}

	var summary map[string]any
	data, err := json.Marshal(messages[index])
	if err != nil {
		t.Fatal(err)
	}

	if err := json.Unmarshal(data, &summary); err != nil {
		t.Fatal(err)
	}

	if summary["pingMs"] == nil || summary["jitterMs"] == nil {
		t.Fatalf("summary = %s, want numeric pingMs and jitterMs", data)
	}

	index++

	if index != len(messages)-1 || messages[index].Type != "done" {
		t.Fatalf("last message = %#v, want done after all results", messages)
	}
}

func TestRunBusyFallback(t *testing.T) {
	manager := newTestManager(t)
	listener, host, port := listenForProbe(t)

	defer listener.Close()

	t.Setenv("IPERF_BUSY_PORT", strconv.Itoa(port))

	var messages []Message
	err := manager.Run(context.Background(), Request{Host: host, PortFrom: port, PortTo: port + 1, Duration: 5, Streams: 2}, func(value any) {
		messages = append(messages, value.(Message))
	})
	if err != nil {
		t.Fatal(err)
	}

	phasePorts := make(map[string]int)

	for _, message := range messages {
		if message.Type == "phase" {
			phasePorts[message.Phase] = message.Port
		}
	}

	for _, phase := range []string{"download", "upload", "ping"} {
		if phasePorts[phase] != port+1 {
			t.Fatalf("%s phase port = %d, want fallback port %d: %#v", phase, phasePorts[phase], port+1, messages)
		}
	}
}

func TestRunKeepsSpeedResultsWhenAllPingSamplesFail(t *testing.T) {
	manager := newTestManager(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	port := listener.Addr().(*net.TCPAddr).Port

	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	var messages []Message
	err = manager.Run(context.Background(), Request{Host: "127.0.0.1", PortFrom: port, PortTo: port, Duration: 5, Streams: 2}, func(value any) {
		messages = append(messages, value.(Message))
	})
	if err != nil {
		t.Fatalf("Run() error = %v, want retained speed results and done", err)
	}

	failedSamples := 0

	for _, message := range messages {
		if message.Type == "pingSample" {
			failedSamples++

			if message.MS != nil {
				t.Fatalf("failed sample = %#v, want nil ms", message)
			}
		}
	}

	if failedSamples != 10 {
		t.Fatalf("got %d failed ping samples, want 10: %#v", failedSamples, messages)
	}

	data, err := json.Marshal(messages[len(messages)-2])
	if err != nil {
		t.Fatal(err)
	}

	var summary map[string]any

	if err := json.Unmarshal(data, &summary); err != nil {
		t.Fatal(err)
	}

	if summary["type"] != "ping" || summary["pingMs"] != nil || summary["jitterMs"] != nil {
		t.Fatalf("penultimate message = %s, want null ping summary", data)
	}

	if messages[len(messages)-1].Type != "done" {
		t.Fatalf("last message = %#v, want done", messages[len(messages)-1])
	}

	results := 0

	for _, message := range messages {
		if message.Type == "result" {
			results++
		}

		if message.Type == "error" {
			t.Fatalf("unexpected error message: %#v", message)
		}
	}

	if results != 2 {
		t.Fatalf("got %d speed results, want download and upload", results)
	}
}

func TestRunWholeRangeBusy(t *testing.T) {
	manager := newTestManager(t)

	t.Setenv("IPERF_BUSY_ALL", "1")

	listener, host, port := listenForProbe(t)

	defer listener.Close()

	err := manager.Run(context.Background(), Request{Host: host, PortFrom: port, PortTo: port + 1, Duration: 5, Streams: 2}, func(any) {})
	if !errors.Is(err, ErrServerBusy) {
		t.Fatalf("Run() error = %v, want ErrServerBusy", err)
	}
}

func TestSecondStartBusy(t *testing.T) {
	manager := newTestManager(t)

	configureFirstRunSleep(t)

	listener, host, port := listenForProbe(t)

	defer listener.Close()

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	events := make(chan Message, 16)
	result := make(chan error, 1)

	go func() {
		result <- manager.Run(ctx, validRequestFor(host, port), func(value any) {
			events <- value.(Message)
		})
	}()

	waitForType(t, events, "interval")

	if err := manager.Run(context.Background(), validRequestFor(host, port), func(any) {}); !errors.Is(err, ErrBusy) {
		t.Fatalf("second Run() error = %v, want ErrBusy", err)
	}

	cancel()

	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("first Run() error = %v, want nil after cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first Run() did not stop after cancellation")
	}
}

func TestShutdownKillsChild(t *testing.T) {
	manager := newTestManager(t)

	configureFirstRunSleep(t)

	pidFile := filepath.Join(t.TempDir(), "child.pid")

	t.Setenv("IPERF_PID_FILE", pidFile)

	listener, host, port := listenForProbe(t)

	defer listener.Close()

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	events := make(chan Message, 16)
	result := make(chan error, 1)

	go func() {
		result <- manager.Run(ctx, validRequestFor(host, port), func(value any) {
			events <- value.(Message)
		})
	}()

	waitForType(t, events, "interval")

	pidBytes, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}

	pid, err := strconv.Atoi(string(bytes.TrimSpace(pidBytes)))
	if err != nil {
		t.Fatal(err)
	}

	cancel()

	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil after cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not stop after cancellation")
	}

	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child pid %d still exists after Run returned: %v", pid, err)
	}
}

func validRequest(host string) Request {
	return Request{Host: host, PortFrom: 5201, PortTo: 5201, Duration: 10, Streams: 4}
}

func validRequestFor(host string, port int) Request {
	return Request{Host: host, PortFrom: port, PortTo: port, Duration: 5, Streams: 1}
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()

	_, source, _, ok := runtime.Caller(0)

	if !ok {
		t.Fatal("runtime.Caller failed")
	}

	packageDir := filepath.Dir(source)
	script, err := os.ReadFile(filepath.Join(packageDir, "testdata", "fake-iperf3.sh"))
	if err != nil {
		t.Fatal(err)
	}

	binary := filepath.Join(t.TempDir(), "fake-iperf3")

	if err := os.WriteFile(binary, script, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("IPERF3_PATH", binary)
	t.Setenv("IPERF_FIXTURE_DIR", filepath.Clean(filepath.Join(packageDir, "../iperf/testdata")))
	t.Setenv("IPERF_BUSY_PORT", "")
	t.Setenv("IPERF_BUSY_ALL", "0")
	t.Setenv("IPERF_SLEEP_FIRST", "0")
	t.Setenv("IPERF_CALLS_FILE", "")
	t.Setenv("IPERF_PID_FILE", "")

	return NewManager()
}

func configureFirstRunSleep(t *testing.T) {
	t.Helper()
	t.Setenv("IPERF_SLEEP_FIRST", "1")
	t.Setenv("IPERF_CALLS_FILE", filepath.Join(t.TempDir(), "calls.txt"))
}

func listenForProbe(t *testing.T) (net.Listener, string, int) {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}

			_ = connection.Close()
		}
	}()

	address := listener.Addr().(*net.TCPAddr)

	return listener, "127.0.0.1", address.Port
}

func waitForType(t *testing.T, events <-chan Message, messageType string) Message {
	t.Helper()

	timer := time.NewTimer(2 * time.Second)

	defer timer.Stop()

	for {
		select {
		case message := <-events:
			if message.Type == messageType {
				return message
			}
		case <-timer.C:
			t.Fatalf("did not receive %s message", messageType)
		}
	}
}
