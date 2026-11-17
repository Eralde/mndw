package httpx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteErrorMarksDaemonErrorResponses(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		code   string
	}{
		{name: "client error", status: http.StatusBadRequest, code: CodeBadRequest},
		{name: "server error", status: http.StatusInternalServerError, code: CodeInternal},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()

			WriteError(response, nil, NewError(test.status, test.code, "failure"))

			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}

			if got := response.Header().Get(HeaderErrorMarker); got != "1" {
				t.Fatalf("%s = %q, want 1", HeaderErrorMarker, got)
			}

			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}

			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}

			if body.Error.Code != test.code {
				t.Fatalf("error code = %q, want %q", body.Error.Code, test.code)
			}
		})
	}
}
