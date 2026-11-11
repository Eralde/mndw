package httpsocket

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const shutdownTimeout = 10 * time.Second

// Serve serves handler over a Unix socket until ctx is canceled. It waits up to
// 10 seconds for in-flight handlers to finish before closing remaining connections.
func Serve(ctx context.Context, socketPath string, handler http.Handler) error {
	return serveWithShutdownTimeout(ctx, socketPath, handler, shutdownTimeout)
}

func serveWithShutdownTimeout(ctx context.Context, socketPath string, handler http.Handler, timeout time.Duration) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return err
	}

	_ = os.Remove(socketPath)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		return err
	}
	listener.SetUnlinkOnClose(false)

	defer func() {
		_ = listener.Close()
		_ = os.Remove(socketPath)
	}()

	_ = os.Chmod(socketPath, 0o600)
	server := newServer(handler)
	shutdownDone := make(chan error, 1)

	go func() {
		<-ctx.Done()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()

		shutdownErr := server.Shutdown(shutdownCtx)
		if shutdownErr != nil {
			_ = server.Close()
		}

		shutdownDone <- shutdownErr
	}()

	err = server.Serve(listener)
	if err == http.ErrServerClosed {
		return <-shutdownDone
	}

	return err
}

func newServer(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
}
