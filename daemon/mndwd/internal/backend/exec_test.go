package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
