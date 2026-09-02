package deviceinfo

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandlerReturnsHardwareOnGet(t *testing.T) {
	store := NewStore(&fakeFetcher{snapshot: Snapshot{Switchports: Switchports{List: []Switchport{{ID: "WAN"}}}, USBPortCount: 1}}, StoreOptions{})
	mux := http.NewServeMux()

	NewHandler(store, nil).RegisterProtected(mux)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/mgmt/device-hardware", nil)

	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}

	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}

	var body Snapshot

	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if len(body.Switchports.List) != 1 || body.Switchports.List[0].ID != "WAN" || body.USBPortCount != 1 {
		t.Fatalf("response hardware = %+v, want WAN and USB count 1", body)
	}
}

func TestHandlerReturnsBadGatewayEnvelopeOnStoreFailure(t *testing.T) {
	store := NewStore(&fakeFetcher{err: errors.New("device down")}, StoreOptions{})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/mgmt/device-hardware", nil)

	NewHandler(store, nil).handleGet(recorder, request)

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}

	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}

	if body.Error.Code != "BAD_GATEWAY" {
		t.Fatalf("error code = %q, want BAD_GATEWAY", body.Error.Code)
	}

	if len(recorder.Body.Bytes()) == 0 {
		t.Fatal("failure returned empty body")
	}
}

func TestHandlerDoesNotServeNonGetRequests(t *testing.T) {
	store := NewStore(&fakeFetcher{snapshot: emptySnapshot()}, StoreOptions{})
	mux := http.NewServeMux()

	NewHandler(store, nil).RegisterProtected(mux)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/mgmt/device-hardware", nil)

	mux.ServeHTTP(recorder, request)

	if recorder.Code == http.StatusOK {
		t.Fatal("POST became a successful device-port read")
	}
}

func TestStoreRespectsCanceledContextBeforeFetch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	fetcher := &fakeFetcher{snapshot: emptySnapshot()}
	store := NewStore(fetcher, StoreOptions{})

	_, _ = store.Get(ctx, "")

	if fetcher.callCount() != 0 {
		t.Fatal("canceled request invoked fetcher")
	}
}
