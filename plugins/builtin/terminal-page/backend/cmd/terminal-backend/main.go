package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"terminal-page/internal/server"
)

func main() {
	backend, err := server.New(os.Getenv)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	defer stop()

	if err := backend.Run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}
}
