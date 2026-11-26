// Package run provides the mws-page backend entry point shared by the standalone
// cmd/mwsd binary and mndwd's "mndwd backend mwsd" command.
package run

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"mws-page/internal/config"
	"mws-page/internal/httpapi"
	"mws-page/internal/service"
)

// Main runs the backend and returns the process exit code. args excludes the program name. It panics on a
// configuration or server error, as the standalone binary always did.
func Main(args []string) int {
	cfg, err := config.Parse(args, os.Getenv)
	if err != nil {
		panic(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	defer stop()

	mwsd := service.New(cfg)

	go mwsd.Run(ctx)

	server, err := httpapi.New(mwsd)
	if err != nil {
		panic(err)
	}

	if err := server.Run(ctx); err != nil {
		panic(err)
	}

	return 0
}
