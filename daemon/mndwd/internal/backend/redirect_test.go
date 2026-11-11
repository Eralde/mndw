package backend

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
)

func TestGatewayServiceRedirectReturnedWithoutFollowing(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	socketPath := startDiagnosticsServer(t, func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		paths = append(paths, request.URL.Path)
		mu.Unlock()

		if request.URL.Path == "/health" {
			writer.Header().Set("Location", "/undeclared")
			writer.WriteHeader(http.StatusFound)

			return
		}

		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("private response"))
	})

	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: filepath.Dir(socketPath)})
	runtime.supervisor = supervisorForDiagnosticsSocket(socketPath)
	gateway := newPreludeGateway(t, authPass(), runtime)
	mux := http.NewServeMux()
	gateway.Register(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/plugins/demo/health", nil))

	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d (body %q)", recorder.Code, http.StatusFound, recorder.Body.String())
	}

	if got := recorder.Header().Get("Location"); got != "/undeclared" {
		t.Fatalf("Location = %q, want %q", got, "/undeclared")
	}

	mu.Lock()
	defer mu.Unlock()

	if len(paths) != 1 || paths[0] != "/health" {
		t.Fatalf("upstream paths = %#v, want only /health", paths)
	}
}
