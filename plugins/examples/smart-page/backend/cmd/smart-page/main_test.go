package main

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"

	"smart-page/internal/devices"
	"smart-page/internal/model"
	"smart-page/internal/monitor"
)

func TestShutdownDeadlineErrorSocketCleanup(t *testing.T) {
	tests := []struct {
		name           string
		serveReturned  bool
		wantSocketFile bool
	}{
		{name: "serve outstanding"},
		{name: "serve returned", serveReturned: true, wantSocketFile: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			socketPath := filepath.Join(t.TempDir(), "plugin.sock")

			if err := os.WriteFile(socketPath, []byte("socket"), 0o600); err != nil {
				t.Fatalf("write socket marker: %v", err)
			}

			serveResult := make(chan error, 1)

			if test.serveReturned {
				serveResult <- nil
			}

			if err := shutdownDeadlineError(socketPath, context.DeadlineExceeded, serveResult, false); err == nil {
				t.Fatal("shutdown deadline error is nil")
			}

			_, err := os.Stat(socketPath)

			if test.wantSocketFile && err != nil {
				t.Fatalf("socket stat = %v, want socket preserved", err)
			}

			if !test.wantSocketFile && !os.IsNotExist(err) {
				t.Fatalf("socket stat = %v, want socket removed", err)
			}
		})
	}
}

func TestShutdownHelperProcess(t *testing.T) {
	if os.Getenv("SMART_PAGE_SHUTDOWN_HELPER") != "1" {
		return
	}

	controller := monitor.New(monitor.Dependencies{
		Executor: shutdownTestExecutor{},
		Registry: devices.NewRegistry(nil, nil),
	})
	serviceContext, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)

	defer stop()

	releaseHandler := make(chan struct{})

	if os.Getenv("SMART_PAGE_SHUTDOWN_MODE") == "release-on-signal" {
		go func() {
			<-serviceContext.Done()
			close(releaseHandler)
		}()
	}

	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/ready":
			response.WriteHeader(http.StatusNoContent)
		case "/start":
			if _, err := controller.SubmitDiscover(); err != nil {
				http.Error(response, err.Error(), http.StatusInternalServerError)

				return
			}

			response.WriteHeader(http.StatusAccepted)
		case "/block":
			_ = os.WriteFile(os.Getenv("SMART_PAGE_SHUTDOWN_HANDLER_STARTED"), []byte("started"), 0o600)

			<-releaseHandler
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	})

	err := runService(serviceContext, os.Getenv("SMART_PAGE_SHUTDOWN_SOCKET"), controller, handler)
	if err != nil {
		_ = os.WriteFile(os.Getenv("SMART_PAGE_SHUTDOWN_RUN_ERROR"), []byte(err.Error()), 0o600)
	}
}

func TestShutdownChildProcess(t *testing.T) {
	if os.Getenv("SMART_PAGE_SHUTDOWN_CHILD") != "1" {
		return
	}

	if err := os.WriteFile(os.Getenv("SMART_PAGE_SHUTDOWN_CHILD_STARTED"), []byte("started"), 0o600); err != nil {
		t.Fatalf("write child started marker: %v", err)
	}

	select {}
}

type shutdownTestExecutor struct{}

func (shutdownTestExecutor) Run(ctx context.Context, _ model.Command) model.CommandResult {
	return runShutdownTestChild(ctx)
}

func (shutdownTestExecutor) Scan(ctx context.Context) model.CommandResult {
	return runShutdownTestChild(ctx)
}

func (shutdownTestExecutor) ScanSCSI(ctx context.Context) model.CommandResult {
	return runShutdownTestChild(ctx)
}

func runShutdownTestChild(ctx context.Context) model.CommandResult {
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestShutdownChildProcess$")
	child.Env = append(os.Environ(), "SMART_PAGE_SHUTDOWN_CHILD=1")

	if err := child.Start(); err != nil {
		return model.CommandResult{ExitCode: -1, Failure: model.FailureStartFailed}
	}

	err := child.Wait()
	_ = os.WriteFile(os.Getenv("SMART_PAGE_SHUTDOWN_CHILD_REAPED"), []byte("reaped"), 0o600)

	if ctx.Err() != nil {
		return model.CommandResult{ExitCode: -1, Failure: model.FailureCanceled}
	}

	if err != nil {
		return model.CommandResult{ExitCode: -1, Failure: model.FailureWaitFailed}
	}

	return model.CommandResult{ExitCode: 0}
}
