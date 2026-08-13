package backend

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mndwd/internal/httpx"
)

type ExecRequest struct {
	PluginID   string
	RouteID    string
	Dir        string
	Command    string
	RuntimeDir string
	Method     string
	Query      string
	Body       []byte
	Type       string
}

type ExecRunnerConfig struct {
	Timeout                    time.Duration
	KillGrace                  time.Duration
	MaxBodyBytes               int64
	MaxOutputBytes             int64
	MaxConcurrentExecTotal     int
	MaxConcurrentExecPerPlugin int
	RuntimeRoot                string
	PluginDataRoot             string
	Logger                     *slog.Logger
	Dev                        bool
}

type ExecRunner struct {
	cfg       ExecRunnerConfig
	admission *Admission
}

func NewExecRunner(cfg ExecRunnerConfig) *ExecRunner {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}

	if cfg.KillGrace <= 0 {
		cfg.KillGrace = 2 * time.Second
	}

	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 1 << 20
	}

	if cfg.MaxOutputBytes <= 0 {
		cfg.MaxOutputBytes = 8 << 20
	}

	if cfg.MaxConcurrentExecTotal <= 0 {
		cfg.MaxConcurrentExecTotal = 8
	}

	if cfg.MaxConcurrentExecPerPlugin <= 0 {
		cfg.MaxConcurrentExecPerPlugin = 4
	}

	return newExecRunner(cfg, NewAdmission(Limits{
		MaxConcurrentExecTotal:     cfg.MaxConcurrentExecTotal,
		MaxConcurrentExecPerPlugin: cfg.MaxConcurrentExecPerPlugin,
	}))
}

func newExecRunner(cfg ExecRunnerConfig, admission *Admission) *ExecRunner {
	return &ExecRunner{cfg: cfg, admission: admission}
}

func (r *ExecRunner) Serve(ctx context.Context, request ExecRequest, writer http.ResponseWriter) *httpx.APIError {
	if int64(len(request.Body)) > r.cfg.MaxBodyBytes {
		return httpx.NewError(http.StatusRequestEntityTooLarge, httpx.CodeBackendBodyTooLarge, "request body exceeds backend limit")
	}

	reservation, admitted := r.admission.TryAcquireExec(request.PluginID)

	if !admitted {
		return httpx.NewError(http.StatusTooManyRequests, httpx.CodeBackendBusy, "backend execution capacity is busy")
	}

	defer reservation.Release()

	command := exec.Command(request.Command)

	configureExecCommand(command)

	command.Dir = request.Dir
	runtimeDirectory := request.RuntimeDir

	if runtimeDirectory == "" && r.cfg.RuntimeRoot != "" {
		paths, err := NewRuntimePaths(r.cfg.RuntimeRoot, request.PluginID)
		if err != nil {
			return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "backend runtime path is invalid")
		}

		if err := paths.Ensure(); err != nil {
			return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "backend runtime directory is unavailable")
		}

		runtimeDirectory = paths.PluginDir
	}

	dataDirectory := request.Dir

	if r.cfg.PluginDataRoot != "" {
		dataDirectory = filepath.Join(r.cfg.PluginDataRoot, request.PluginID)

		if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
			return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "backend data directory is unavailable")
		}

		if err := os.Chmod(dataDirectory, 0o700); err != nil {
			return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "backend data directory is unavailable")
		}
	}

	contentType := request.Type

	if contentType == "" {
		contentType = "application/json"
	}

	command.Env = BuildChildEnvironment(EnvironmentSpec{
		Path:             os.Getenv("PATH"),
		PluginID:         request.PluginID,
		PluginDir:        request.Dir,
		PluginDataDir:    dataDirectory,
		PluginRuntimeDir: runtimeDirectory,
	})
	command.Env = append(command.Env,
		"REQUEST_METHOD="+request.Method,
		"QUERY_STRING="+request.Query,
		"CONTENT_TYPE="+contentType,
		"CONTENT_LENGTH="+strconv.Itoa(len(request.Body)),
		"MNDW_ROUTE_ID="+request.RouteID,
	)
	command.Stdin = bytes.NewReader(request.Body)
	stdout := &boundedBuffer{limit: r.cfg.MaxOutputBytes}
	stderr := &boundedBuffer{limit: 4 << 10}
	command.Stdout = stdout
	command.Stderr = stderr

	deadlineCtx, cancel := context.WithTimeout(ctx, r.cfg.Timeout)

	defer cancel()

	done := make(chan error, 1)

	go func() {
		done <- command.Run()
	}()

	var runErr error

	select {
	case runErr = <-done:
	case <-deadlineCtx.Done():
		terminateAndReap(command, done, r.cfg.KillGrace)

		return httpx.NewError(http.StatusGatewayTimeout, httpx.CodeScriptTimeout, "backend execution timed out")
	}

	if runErr != nil {
		apiErr := httpx.NewError(http.StatusBadGateway, httpx.CodeScriptFailed, "backend execution failed")

		if r.cfg.Dev && len(stderr.Bytes()) > 0 {
			apiErr.WithDetail(map[string]string{"stderr": redactStderr(stderr.Bytes())})
		}

		return apiErr
	}

	if stdout.Overflowed() {
		return httpx.NewError(http.StatusBadGateway, httpx.CodeBackendOutputTooLarge, "backend response exceeds output limit")
	}

	parsed, err := ParseCGIResponse(stdout.Bytes(), r.cfg.MaxOutputBytes)
	if err != nil {
		return httpx.NewError(http.StatusBadGateway, httpx.CodeScriptFailed, "backend response was malformed")
	}

	for key, values := range parsed.Headers {
		for _, value := range values {
			writer.Header().Add(key, value)
		}
	}

	writer.WriteHeader(parsed.Status)

	_, _ = writer.Write(parsed.Body)

	return nil
}

type boundedBuffer struct {
	bytes.Buffer
	limit    int64
	overflow bool
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	if b.limit <= 0 {
		return len(data), nil
	}

	remaining := b.limit - int64(b.Len())

	if remaining <= 0 {
		b.overflow = true

		return len(data), nil
	}

	if int64(len(data)) > remaining {
		_, _ = b.Buffer.Write(data[:remaining])
		b.overflow = true

		return len(data), nil
	}

	return b.Buffer.Write(data)
}

func (b *boundedBuffer) Overflowed() bool { return b.overflow }

func redactStderr(data []byte) string {
	return strings.Join(redactStderrLines(strings.Split(string(data), "\n")), "\n")
}

func terminateAndReap(command *exec.Cmd, done <-chan error, grace time.Duration) {
	if command.Process == nil {
		return
	}

	_ = terminateExecProcess(command.Process)
	timer := time.NewTimer(grace)

	defer timer.Stop()

	select {
	case <-done:
		return
	case <-timer.C:
		_ = killExecProcess(command.Process)

		<-done
	}
}
