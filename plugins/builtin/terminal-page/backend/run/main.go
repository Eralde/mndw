// Package run provides the terminal-page backend entry point shared by the standalone
// cmd/terminal-backend binary and mndwd's "mndwd backend terminal-backend" command.
package run

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"terminal-page/internal/server"
)

// Main runs the backend and returns the process exit code. args excludes the program name and is unused;
// configuration comes from the environment.
func Main(args []string) int {
	backend, err := server.New(os.Getenv)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	defer stop()

	if err := backend.Run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		return 1
	}

	return 0
}
