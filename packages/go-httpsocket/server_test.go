package httpsocket

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
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

func TestServeWaitsForInFlightRequestBeforeReturning(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "backend.sock")
	ctx, cancel := context.WithCancel(context.Background())
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	var releaseOnce sync.Once
	errCh := make(chan error, 1)
	t.Cleanup(func() {
		cancel()
		releaseOnce.Do(func() { close(releaseHandler) })
	})

	go func() {
		errCh <- Serve(ctx, socketPath, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			close(handlerStarted)
			<-releaseHandler
			_, _ = io.WriteString(writer, "complete response")
		}))
	}()

	waitForSocket(t, socketPath, errCh)
	responseCh := make(chan struct {
		body string
		err  error
	}, 1)
	go func() {
		response, err := unixClient(socketPath).Get("http://unix/")
		if err != nil {
			responseCh <- struct {
				body string
				err  error
			}{err: err}

			return
		}

		defer response.Body.Close()

		body, err := io.ReadAll(response.Body)
		responseCh <- struct {
			body string
			err  error
		}{body: string(body), err: err}
	}()

	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not start")
	}

	cancel()
	waitForSocketListenerClosed(t, socketPath, errCh)

	select {
	case err := <-errCh:
		t.Fatalf("Serve() returned before in-flight handler finished: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	releaseOnce.Do(func() { close(releaseHandler) })

	select {
	case response := <-responseCh:
		if response.err != nil {
			t.Fatalf("request error = %v", response.err)
		}

		if got, want := response.body, "complete response"; got != want {
			t.Fatalf("response body = %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("client did not receive the complete response")
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("Serve() error = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve() did not return after handler finished")
	}

	if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket stat error = %v, want not-exist", err)
	}

}

func TestServeForcesCloseAfterShutdownDeadline(t *testing.T) {
	timeout := 50 * time.Millisecond
	socketPath := filepath.Join(shortTempDir(t), "backend.sock")
	ctx, cancel := context.WithCancel(context.Background())
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	var releaseOnce sync.Once
	errCh := make(chan error, 1)
	requestCh := make(chan error, 1)
	t.Cleanup(func() {
		cancel()
		releaseOnce.Do(func() { close(releaseHandler) })
	})

	go func() {
		errCh <- serveWithShutdownTimeout(ctx, socketPath, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			close(handlerStarted)
			<-releaseHandler
			_, _ = io.WriteString(writer, "late response")
		}), timeout)
	}()

	waitForSocket(t, socketPath, errCh)
	go func() {
		response, err := unixClient(socketPath).Get("http://unix/")
		if err == nil {
			_ = response.Body.Close()
		}
		requestCh <- err
	}()

	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not start")
	}

	cancelledAt := time.Now()
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Serve() error = %v, want shutdown deadline error", err)
		}

		if elapsed := time.Since(cancelledAt); elapsed < timeout {
			t.Fatalf("Serve() returned after %s, before %s deadline", elapsed, timeout)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve() did not return after shutdown deadline")
	}

	select {
	case err := <-requestCh:
		if err == nil {
			t.Fatal("request completed without error after forced shutdown")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("server did not close the in-flight request after deadline")
	}

	if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket stat error = %v, want not-exist", err)
	}

	releaseOnce.Do(func() { close(releaseHandler) })
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

func waitForSocketListenerClosed(t *testing.T, socketPath string, errCh <-chan error) {
	t.Helper()

	deadline := time.NewTimer(2 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)

	defer deadline.Stop()
	defer ticker.Stop()

	for {
		connection, err := net.DialTimeout("unix", socketPath, 20*time.Millisecond)
		if connection != nil {
			_ = connection.Close()
		}

		if errors.Is(err, syscall.ECONNREFUSED) {
			return
		}
		if errors.Is(err, os.ErrNotExist) {
			t.Fatal("socket file removed before in-flight handler finished")
		}

		select {
		case err := <-errCh:
			t.Fatalf("Serve() returned before listener closed: %v", err)
		case <-deadline.C:
			t.Fatalf("listener for %q stayed open", socketPath)
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
