package palette

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func server(t *testing.T) (*httptest.Server, *Store) {
	t.Helper()

	store, err := Open(storePath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	mux := http.NewServeMux()
	handler := NewHandler(store, nil)

	handler.RegisterPublic(mux)
	handler.RegisterProtected(mux)

	srv := httptest.NewServer(mux)

	t.Cleanup(srv.Close)

	return srv, store
}

func do(t *testing.T, srv *httptest.Server, method, body string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(method, srv.URL+"/api/mgmt/palette", bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}

	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}

	t.Cleanup(func() { _ = resp.Body.Close() })

	return resp
}

func wireBody(t *testing.T) string {
	t.Helper()

	data, err := json.Marshal(valid())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	return string(data)
}

func TestGetOnFreshStoreReturnsNullPaletteAndNoStore(t *testing.T) {
	srv, _ := server(t)

	resp := do(t, srv, http.MethodGet, "")

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", resp.StatusCode)
	}

	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}

	var body struct {
		Palette *Palette `json:"palette"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if body.Palette != nil {
		t.Errorf("palette = %+v, want null", body.Palette)
	}
}

func TestPutThenGetRoundTrips(t *testing.T) {
	srv, _ := server(t)

	resp := do(t, srv, http.MethodPut, wireBody(t))

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d, want 204", resp.StatusCode)
	}

	resp = do(t, srv, http.MethodGet, "")
	var body struct {
		Palette *Palette `json:"palette"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if body.Palette == nil || *body.Palette != valid() {
		t.Errorf("palette = %+v, want %+v", body.Palette, valid())
	}
}

func TestPutRejectsMalformedBodies(t *testing.T) {
	validTheme, _ := json.Marshal(valid().Dark)
	theme := string(validTheme)
	unknownTheme := theme[:len(theme)-1] + `,"accentQuiet":"#fff"}`
	cases := map[string]string{
		"not JSON":          `{`,
		"missing theme":     `{"dark":` + theme + `}`,
		"unknown top key":   `{"dark":` + theme + `,"light":` + theme + `,"sepia":{}}`,
		"unknown token key": `{"dark":` + unknownTheme + `,"light":` + theme + `}`,
		"non-hex value":     `{"dark":` + strings.Replace(theme, `"bg":"#000000"`, `"bg":"nope"`, 1) + `,"light":` + theme + `}`,
		"trailing JSON":     wireBody(t) + ` null`,
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			srv, store := server(t)
			resp := do(t, srv, http.MethodPut, body)

			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("PUT status = %d, want 400", resp.StatusCode)
			}

			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}

			if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
				t.Fatalf("decode envelope: %v", err)
			}

			if envelope.Error.Code != "BAD_REQUEST" {
				t.Errorf("error code = %q, want BAD_REQUEST", envelope.Error.Code)
			}

			if _, ok := store.Get(); ok {
				t.Error("rejected PUT stored an override")
			}
		})
	}
}

func TestPutRejectsOversizedBody(t *testing.T) {
	srv, store := server(t)
	body := wireBody(t) + strings.Repeat("x", maxPaletteBytes)

	resp := do(t, srv, http.MethodPut, body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("PUT status = %d, want 400", resp.StatusCode)
	}

	if _, ok := store.Get(); ok {
		t.Error("oversized PUT stored an override")
	}
}

func TestDeleteClearsAndReturns204(t *testing.T) {
	srv, store := server(t)

	if resp := do(t, srv, http.MethodPut, wireBody(t)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("seed PUT status = %d, want 204", resp.StatusCode)
	}

	if resp := do(t, srv, http.MethodDelete, ""); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status = %d, want 204", resp.StatusCode)
	}

	if _, ok := store.Get(); ok {
		t.Error("override survived DELETE")
	}
}

func TestPersistenceFailureIsInternal(t *testing.T) {
	store, err := Open(storePath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	store.path = t.TempDir() + "/missing/palette.json"

	req := httptest.NewRequest(http.MethodPut, "/api/mgmt/palette", strings.NewReader(wireBody(t)))
	res := httptest.NewRecorder()

	NewHandler(store, nil).handlePut(res, req)

	if res.Code != http.StatusInternalServerError {
		t.Fatalf("PUT status = %d, want 500", res.Code)
	}
}
