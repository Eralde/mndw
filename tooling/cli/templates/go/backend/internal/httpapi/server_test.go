package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReadyResponseHasExactKeys(t *testing.T) {
	recorder := httptest.NewRecorder()

	writeJSON(recorder, http.StatusOK, readyResponse{PluginID: "p", ProtocolVersion: 1})

	if contentType := recorder.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", contentType)
	}

	var decoded map[string]any

	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}

	if _, ok := decoded["pluginId"].(string); !ok {
		t.Fatalf("pluginId missing or not string: %#v", decoded["pluginId"])
	}

	if _, ok := decoded["protocolVersion"].(float64); !ok {
		t.Fatalf("protocolVersion missing or not number: %#v", decoded["protocolVersion"])
	}

	if len(decoded) != 2 {
		t.Fatalf("unexpected extra keys: %#v", decoded)
	}
}

func TestHelloRejectsNonGetWith405(t *testing.T) {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /hello", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, helloResponse{})
	})

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/hello", nil))

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}

func TestTimeoutConstants(t *testing.T) {
	if readHeaderTimeout != 5*time.Second {
		t.Fatalf("readHeaderTimeout = %v, want 5s", readHeaderTimeout)
	}

	if shutdownTimeout != 500*time.Millisecond {
		t.Fatalf("shutdownTimeout = %v, want 500ms", shutdownTimeout)
	}
}
