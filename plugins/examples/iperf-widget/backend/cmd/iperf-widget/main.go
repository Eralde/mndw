package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"iperf-widget/internal/httpapi"
	"iperf-widget/internal/session"
)

func main() {
	service, err := httpapi.New(session.NewManager())
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)

	defer stop()

	if err := service.Run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)

		os.Exit(1)
	}
}
