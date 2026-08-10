// Package httpsocket serves HTTP handlers over secure local Unix sockets.
package httpsocket

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Serve owns the Unix socket lifecycle for a local HTTP server. It creates the
// parent directory with mode 0700, the socket with mode 0600, removes stale and
// final socket paths, and returns nil for clean context-driven shutdown.
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

	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		<-ctx.Done()

		_ = server.Shutdown(context.Background())
	}()

	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		return err
	}

	return nil
}
