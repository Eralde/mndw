package httpsocket

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNewServerReadHeaderTimeout(t *testing.T) {
	if got, want := newServer(nil).ReadHeaderTimeout, 5*time.Second; got != want {
		t.Fatalf("ReadHeaderTimeout = %s, want %s", got, want)
	}
}

func TestServeHandlesRequestAndAppliesModes(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "runtime", "backend.sock")
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	errCh := make(chan error, 1)

	go func() {
		errCh <- Serve(ctx, socketPath, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(writer, "ok")
		}))
	}()

	waitForSocket(t, socketPath, errCh)

	parentInfo, err := os.Stat(filepath.Dir(socketPath))
	if err != nil {
		t.Fatal(err)
	}

	if got, want := parentInfo.Mode().Perm(), os.FileMode(0o700); got != want {
		t.Fatalf("parent mode = %o, want %o", got, want)
	}

	socketInfo, err := os.Stat(socketPath)
	if err != nil {
		t.Fatal(err)
	}

	if got, want := socketInfo.Mode().Perm(), os.FileMode(0o600); got != want {
		t.Fatalf("socket mode = %o, want %o", got, want)
	}

	client := unixClient(socketPath)
	response, err := client.Get("http://unix/")
	if err != nil {
		t.Fatal(err)
	}

	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}

	if got, want := string(body), "ok"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}

	cancel()

	if err := <-errCh; err != nil {
		t.Fatalf("Serve() error = %v, want nil", err)
	}

	if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket stat error = %v, want not-exist", err)
	}
}

func TestServeReturnsNilOnCleanContextShutdown(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "backend.sock")
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)

	go func() { errCh <- Serve(ctx, socketPath, http.NotFoundHandler()) }()

	waitForSocket(t, socketPath, errCh)
	cancel()

	if err := <-errCh; err != nil {
		t.Fatalf("Serve() error = %v, want nil", err)
	}
}

func TestServeReturnsSetupError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "not-a-directory")

	if err := os.WriteFile(parent, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := Serve(context.Background(), filepath.Join(parent, "backend.sock"), http.NotFoundHandler())
	if err == nil {
		t.Fatal("Serve() error = nil, want setup error")
	}
}

func unixClient(socketPath string) *http.Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
	}

	return &http.Client{Transport: transport}
}

func waitForSocket(t *testing.T, socketPath string, errCh <-chan error) {
	t.Helper()

	deadline := time.NewTimer(2 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)

	defer deadline.Stop()

	defer ticker.Stop()

	for {
		if _, err := os.Stat(socketPath); err == nil {
			return
		}

		select {
		case err := <-errCh:
			t.Fatalf("Serve() returned before socket creation: %v", err)
		case <-deadline.C:
			t.Fatalf("socket %q was not created", socketPath)
		case <-ticker.C:
		}
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()

	directory, err := os.MkdirTemp("/tmp", "httpsocket-")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(directory) })

	return directory
}
