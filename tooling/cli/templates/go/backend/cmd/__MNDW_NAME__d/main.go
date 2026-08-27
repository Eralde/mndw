package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"__MNDW_NAME__/internal/httpapi"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	defer stop()

	if err := httpapi.Run(ctx); err != nil {
		log.Fatalf("backend exited: %v", err)
	}
}
