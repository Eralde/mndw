package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mndwd/internal/httpx"
)

func TestExecRunnerProvidesBoundedCGIEnvironmentAndBody(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf 'Content-Type: text/plain\\n\\n'\nprintf '%s|%s|%s|%s|%s' \"$REQUEST_METHOD\" \"$QUERY_STRING\" \"$CONTENT_LENGTH\" \"$MNDW_ROUTE_ID\" \"$(cat)\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{Timeout: 5 * time.Second, MaxBodyBytes: 1024, MaxOutputBytes: 4096, MaxConcurrentExecTotal: 2, MaxConcurrentExecPerPlugin: 1})
	recorder := httptest.NewRecorder()
	err := runner.Serve(context.Background(), ExecRequest{
		PluginID: "demo",
		RouteID:  "echo",
		Dir:      dir,
		Command:  command,
		Method:   http.MethodPost,
		Query:    "q=1",
		Body:     []byte("body"),
		Type:     "text/plain",
	}, recorder)
	if err != nil {
		t.Fatal(err)
	}

	if got, want := strings.TrimSpace(recorder.Body.String()), "POST|q=1|4|echo|body"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}

	if recorder.Header().Get("Transfer-Encoding") != "" || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response headers = %#v", recorder.Header())
	}
}

func TestExecRunnerRejectsBodyBeforeSpawn(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\ntouch \"$MARKER\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{Timeout: time.Second, MaxBodyBytes: 2, MaxOutputBytes: 1024})
	recorder := httptest.NewRecorder()
	err := runner.Serve(context.Background(), ExecRequest{PluginID: "demo", RouteID: "x", Dir: dir, Command: command, Body: []byte("too long")}, recorder)
	if err == nil || err.Code != CodeBackendBodyTooLarge {
		t.Fatalf("Serve error = %v, want body-too-large", err)
	}

	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatalf("command spawned on rejected body, stat error = %v", statErr)
	}
}

func TestBoundedBufferHoldsLimitUnderExecCopy(t *testing.T) {
	buffer := &boundedBuffer{limit: 16}
	command := exec.Command("sh", "-c", "head -c 1048576 /dev/zero")
	command.Stdout = buffer

	if err := command.Run(); err != nil {
		t.Fatal(err)
	}

	if got := len(buffer.Bytes()); got != 16 {
		t.Fatalf("buffered = %d, want 16", got)
	}

	if !buffer.Overflowed() {
		t.Fatal("Overflowed() = false, want true")
	}
}

func TestExecRunnerRejectsOutputOverLimit(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf 'Content-Type: text/plain\\n\\n'\nhead -c 65536 /dev/zero\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{Timeout: 5 * time.Second, MaxBodyBytes: 1024, MaxOutputBytes: 1024})
	recorder := httptest.NewRecorder()
	err := runner.Serve(context.Background(), ExecRequest{PluginID: "demo", RouteID: "x", Dir: dir, Command: command}, recorder)
	if err == nil || err.Code != CodeBackendOutputTooLarge || err.Status != http.StatusBadGateway {
		t.Fatalf("Serve error = %v, want %s with status %d", err, CodeBackendOutputTooLarge, http.StatusBadGateway)
	}

	if got := recorder.Body.Len(); got != 0 {
		t.Fatalf("response body length = %d, want 0", got)
	}
}

func TestExecRunnerAcceptsOutputExactlyAtLimit(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf 'Content-Type: text/plain\\n\\n'\nhead -c 998 /dev/zero\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{Timeout: 5 * time.Second, MaxBodyBytes: 1024, MaxOutputBytes: 1024})
	recorder := httptest.NewRecorder()
	err := runner.Serve(context.Background(), ExecRequest{PluginID: "demo", RouteID: "x", Dir: dir, Command: command}, recorder)
	if err != nil {
		t.Fatalf("Serve error = %v, want nil", err)
	}

	if got := recorder.Body.Len(); got != 998 {
		t.Fatalf("response body length = %d, want 998", got)
	}
}

func TestExecRunnerStopsProcessOnOutputOverflow(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf 'Content-Type: text/plain\\n\\n'\nhead -c 65536 /dev/zero\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{
		Timeout:        10 * time.Second,
		KillGrace:      100 * time.Millisecond,
		MaxBodyBytes:   1024,
		MaxOutputBytes: 1024,
	})
	recorder := httptest.NewRecorder()
	started := time.Now()
	err := runner.Serve(context.Background(), ExecRequest{PluginID: "demo", RouteID: "x", Dir: dir, Command: command}, recorder)
	elapsed := time.Since(started)
	if err == nil || err.Code != CodeBackendOutputTooLarge || elapsed >= 3*time.Second {
		t.Fatalf("Serve error = %v, elapsed = %s, want output-too-large within 3s", err, elapsed)
	}
}

func TestExecRunnerTimeoutWithoutOverflowStaysTimeout(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{Timeout: 200 * time.Millisecond, KillGrace: 100 * time.Millisecond})
	recorder := httptest.NewRecorder()
	err := runner.Serve(context.Background(), ExecRequest{PluginID: "demo", RouteID: "x", Dir: dir, Command: command}, recorder)
	if err == nil || err.Code != httpx.CodeScriptTimeout || err.Status != http.StatusGatewayTimeout {
		t.Fatalf("Serve error = %v, want %s with status %d", err, httpx.CodeScriptTimeout, http.StatusGatewayTimeout)
	}
}

func TestExecRunnerLargeStderrDoesNotStopProcess(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "helper.sh")

	if err := os.WriteFile(command, []byte("#!/bin/sh\nhead -c 16384 /dev/zero >&2\nprintf 'Content-Type: text/plain\\n\\nok'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runner := NewExecRunner(ExecRunnerConfig{Timeout: 5 * time.Second, MaxOutputBytes: 1024})
	recorder := httptest.NewRecorder()
	err := runner.Serve(context.Background(), ExecRequest{PluginID: "demo", RouteID: "x", Dir: dir, Command: command}, recorder)
	if err != nil {
		t.Fatalf("Serve error = %v, want nil", err)
	}

	if got, want := recorder.Body.String(), "ok"; got != want {
		t.Fatalf("response body = %q, want %q", got, want)
	}
}
