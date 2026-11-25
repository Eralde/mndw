package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"mndw.local/httpsocket"
	"smart-page/internal/devices"
	"smart-page/internal/diagnostics"
	"smart-page/internal/httpapi"
	"smart-page/internal/model"
	"smart-page/internal/monitor"
	"smart-page/internal/smartctl"
)

const shutdownBudget = 5 * time.Second

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)

	defer stop()

	if err := run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	socketPath := os.Getenv("MNDW_BACKEND_SOCKET")

	if socketPath == "" {
		return errors.New("MNDW_BACKEND_SOCKET is required")
	}

	var executor monitor.Executor
	var versionProbe monitor.UtilityVersionProbe
	var utility model.UtilityDiagnostic
	diagnosticReasons := make([]model.Text, 0)

	if binary, err := smartctl.ResolveBinary(); err == nil {
		runner := smartctl.NewRunner(binary)
		executor = runner
		path := model.Text(binary)
		utility.Path = &path
		utility.Available = true
		versionProbe = func(ctx context.Context) (*model.Text, []model.Text) {
			versionResult := runner.Version(ctx)

			if versionResult.Failure == "" && versionResult.ExitCode == 0 {
				version := strings.TrimSpace(strings.SplitN(string(versionResult.Stdout), "\n", 2)[0])

				if version != "" {
					versionText := model.Text(version)

					return &versionText, nil
				}
			}

			return nil, []model.Text{"utility-version-unknown"}
		}
	} else {
		diagnosticReasons = append(diagnosticReasons, "utility-unavailable")
	}

	controller := monitor.New(monitor.Dependencies{
		Executor:            executor,
		Registry:            devices.NewRegistry(devices.NewOS(), nil),
		ProcessReader:       diagnostics.NewProcReader("/proc"),
		Utility:             utility,
		DiagnosticReasons:   diagnosticReasons,
		UtilityVersionProbe: versionProbe,
	})

	return runService(ctx, socketPath, controller, httpapi.New(controller, os.Getenv("MNDW_PLUGIN_ID"), 1))
}

func runService(ctx context.Context, socketPath string, controller *monitor.Controller, handler http.Handler) error {
	serviceContext, cancel := context.WithCancel(ctx)

	defer cancel()

	go controller.Run(serviceContext)

	serveResult := make(chan error, 1)

	go func() {
		serveResult <- httpsocket.Serve(serviceContext, socketPath, handler)
	}()

	select {
	case serveErr := <-serveResult:
		if ctx.Err() != nil {
			return shutdownService(cancel, socketPath, controller, serveResult, serveErr, true)
		}

		cancel()

		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), shutdownBudget)

		defer cleanupCancel()

		return errors.Join(serveErr, controller.Close(cleanupContext))
	case <-ctx.Done():
		return shutdownService(cancel, socketPath, controller, serveResult, nil, false)
	}
}

func shutdownService(
	cancel context.CancelFunc,
	socketPath string,
	controller *monitor.Controller,
	serveResult <-chan error,
	serveErr error,
	serveDone bool,
) error {
	deadlineContext, deadlineCancel := context.WithTimeout(context.Background(), shutdownBudget)

	defer deadlineCancel()

	cancel()

	return drainService(deadlineContext, socketPath, controller, serveResult, serveErr, serveDone)
}

func drainService(
	deadlineContext context.Context,
	socketPath string,
	controller *monitor.Controller,
	serveResult <-chan error,
	serveErr error,
	serveDone bool,
) error {
	// M3 final history flush belongs in drainService and must use deadlineContext.
	closeResult := make(chan error, 1)

	go func() {
		closeResult <- controller.Close(deadlineContext)
	}()

	var closeErr error
	closeDone := false

	for !closeDone || !serveDone {
		if deadlineContext.Err() != nil {
			return shutdownDeadlineError(socketPath, deadlineContext.Err(), serveResult, serveDone)
		}

		select {
		case closeErr = <-closeResult:
			closeDone = true

			if errors.Is(closeErr, context.DeadlineExceeded) {
				return shutdownDeadlineError(socketPath, closeErr, serveResult, serveDone)
			}
		case serveErr = <-serveResult:
			serveDone = true
		case <-deadlineContext.Done():
			return shutdownDeadlineError(socketPath, deadlineContext.Err(), serveResult, serveDone)
		}
	}

	return errors.Join(closeErr, serveErr)
}

func shutdownDeadlineError(socketPath string, cause error, serveResult <-chan error, serveDone bool) error {
	if !serveDone {
		select {
		case <-serveResult:
			serveDone = true
		default:
		}
	}

	if !serveDone {
		_ = os.Remove(socketPath)
	}

	return fmt.Errorf("shutdown deadline exceeded; cleanup is not guaranteed: %w", cause)
}
