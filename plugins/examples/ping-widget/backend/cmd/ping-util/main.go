package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"ping-widget/internal/daemon"
	"ping-widget/internal/httpapi"
)

func main() {
	server, err := daemon.NewServer()
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}

	service, err := httpapi.New(server)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)

	defer stop()

	server.Start(ctx)

	if err := service.Run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}
}
