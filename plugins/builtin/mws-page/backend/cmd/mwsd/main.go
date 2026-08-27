package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"mws-page/internal/config"
	"mws-page/internal/httpapi"
	"mws-page/internal/service"
)

func main() {
	cfg, err := config.Parse(os.Args[1:], os.Getenv)
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
}
