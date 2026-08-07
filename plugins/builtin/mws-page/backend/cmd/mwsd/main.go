package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"mws-page/internal/config"
	"mws-page/internal/service"
	"mws-page/internal/socket"
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
	server := &socket.Server{Path: cfg.SocketPath(), PIDPath: cfg.PIDPath(), IOTimeout: cfg.IOTimeout, AuthTimeout: cfg.AuthOperation, RequestLimit: cfg.MaxRequestBytes, ResponseLimit: cfg.MaxResponseBytes, Service: mwsd}
	if err := server.Listen(); err != nil {
		panic(err)
	}
	defer server.Close()
	_ = mwsd.WriteDiagnostics()
	if err := server.Serve(ctx); err != nil {
		panic(err)
	}
}
