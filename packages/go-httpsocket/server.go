package httpsocket

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func Serve(ctx context.Context, socketPath string, handler http.Handler) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return err
	}

	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}

	defer func() {
		_ = listener.Close()
		_ = os.Remove(socketPath)
	}()

	_ = os.Chmod(socketPath, 0o600)
	server := newServer(handler)

	go func() {
		<-ctx.Done()

		_ = server.Shutdown(context.Background())
	}()

	err = server.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}

	return err
}

func newServer(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
}
