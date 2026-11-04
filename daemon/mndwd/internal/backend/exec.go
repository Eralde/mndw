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
	"sync/atomic"
	"time"

	"mndwd/internal/httpx"
)

const DefaultMaxOutputBytes int64 = 8 << 20

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
	cfg = normalizeExecConfig(cfg)

	return newExecRunner(cfg, NewAdmission(Limits{
		MaxConcurrentExecTotal:     cfg.MaxConcurrentExecTotal,
		MaxConcurrentExecPerPlugin: cfg.MaxConcurrentExecPerPlugin,
	}))
}

func normalizeExecConfig(cfg ExecRunnerConfig) ExecRunnerConfig {
	defaults := DefaultLimits()

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
		cfg.MaxOutputBytes = DefaultMaxOutputBytes
	}

	if cfg.MaxConcurrentExecTotal <= 0 {
		cfg.MaxConcurrentExecTotal = defaults.MaxConcurrentExecTotal
	}

	if cfg.MaxConcurrentExecPerPlugin <= 0 {
		cfg.MaxConcurrentExecPerPlugin = defaults.MaxConcurrentExecPerPlugin
	}

	return cfg
}

func newExecRunner(cfg ExecRunnerConfig, admission *Admission) *ExecRunner {
	cfg = normalizeExecConfig(cfg)

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
	deadlineCtx, cancel := context.WithTimeout(ctx, r.cfg.Timeout)

	defer cancel()

	stdout := &boundedBuffer{limit: r.cfg.MaxOutputBytes, onOverflow: cancel}
	stderr := &boundedBuffer{limit: 4 << 10}
	command.Stdout = stdout
	command.Stderr = stderr

	done := make(chan error, 1)

	go func() {
		done <- command.Run()
	}()

	var runErr error

	select {
	case runErr = <-done:
	case <-deadlineCtx.Done():
		terminateAndReap(command, done, r.cfg.KillGrace)

		if stdout.Overflowed() {
			return httpx.NewError(http.StatusBadGateway, httpx.CodeBackendOutputTooLarge, "backend response exceeds output limit")
		}

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
	buf        bytes.Buffer
	limit      int64
	overflow   atomic.Bool
	onOverflow func()
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	if b.limit <= 0 {
		return len(data), nil
	}

	remaining := b.limit - int64(b.buf.Len())

	if remaining <= 0 {
		b.markOverflow()

		return len(data), nil
	}

	if int64(len(data)) > remaining {
		_, _ = b.buf.Write(data[:remaining])
		b.markOverflow()

		return len(data), nil
	}

	return b.buf.Write(data)
}

func (b *boundedBuffer) Bytes() []byte { return b.buf.Bytes() }

func (b *boundedBuffer) markOverflow() {
	if b.overflow.CompareAndSwap(false, true) && b.onOverflow != nil {
		b.onOverflow()
	}
}

func (b *boundedBuffer) Overflowed() bool { return b.overflow.Load() }

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
