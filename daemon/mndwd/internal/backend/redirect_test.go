package backend

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
)

func TestGatewayServiceRedirectReturnedWithoutFollowing(t *testing.T) {
	for _, status := range []int{http.StatusFound, http.StatusSeeOther} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			type upstreamRequest struct {
				method string
				path   string
			}

			var mu sync.Mutex
			var requests []upstreamRequest
			socketPath := startDiagnosticsServer(t, func(writer http.ResponseWriter, request *http.Request) {
				mu.Lock()
				requests = append(requests, upstreamRequest{method: request.Method, path: request.URL.Path})
				mu.Unlock()

				if request.URL.Path == "/mutate" {
					writer.Header().Set("Location", "/undeclared")
					writer.WriteHeader(status)

					return
				}

				writer.WriteHeader(http.StatusOK)
			})

			runtime := NewRuntime(RuntimeConfig{RuntimeRoot: filepath.Dir(socketPath)})
			runtime.supervisor = supervisorForDiagnosticsSocket(socketPath)
			gateway := newPreludeGateway(t, authPass(), runtime)
			mux := http.NewServeMux()
			gateway.Register(mux)

			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/plugins/demo/mutate", nil)
			request.Header.Set("X-Mndw-Csrf", "1")
			mux.ServeHTTP(recorder, request)

			if recorder.Code != status {
				t.Fatalf("status = %d, want %d (body %q)", recorder.Code, status, recorder.Body.String())
			}

			if got := recorder.Header().Get("Location"); got != "/undeclared" {
				t.Fatalf("Location = %q, want %q", got, "/undeclared")
			}

			mu.Lock()
			defer mu.Unlock()

			if len(requests) != 1 || requests[0] != (upstreamRequest{method: http.MethodPost, path: "/mutate"}) {
				t.Fatalf("upstream requests = %#v, want one POST /mutate", requests)
			}
		})
	}
}
