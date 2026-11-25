package monitor_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"smart-page/internal/httpapi"
	"smart-page/internal/model"
	"smart-page/internal/monitor"
)

func TestReadinessBeforeVersionProbeCompletes(t *testing.T) {
	probeStarted := make(chan struct{})
	probeCanceled := make(chan struct{})
	controller := monitor.New(monitor.Dependencies{
		Utility: model.UtilityDiagnostic{Available: true},
		UtilityVersionProbe: func(ctx context.Context) (*model.Text, []model.Text) {
			close(probeStarted)
			<-ctx.Done()
			close(probeCanceled)

			return nil, nil
		},
	})
	serviceContext, cancelService := context.WithCancel(context.Background())
	runDone := make(chan struct{})

	go func() {
		controller.Run(serviceContext)
		close(runDone)
	}()

	t.Cleanup(func() {
		cancelService()

		closeContext, cancelClose := context.WithTimeout(context.Background(), 50*time.Millisecond)

		defer cancelClose()

		_ = controller.Close(closeContext)
	})

	select {
	case <-probeStarted:
	case <-time.After(50 * time.Millisecond):
		t.Fatal("startup version probe did not start")
	}

	handler := httpapi.New(controller, "smart-page", 1)
	ready := httptest.NewRecorder()

	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/_mndw/ready", nil))

	if ready.Code != http.StatusOK {
		t.Fatalf("readiness status = %d, want %d", ready.Code, http.StatusOK)
	}

	select {
	case <-probeCanceled:
		t.Fatal("version probe canceled before shutdown")
	default:
	}

	snapshotResponse := httptest.NewRecorder()

	handler.ServeHTTP(snapshotResponse, httptest.NewRequest(http.MethodGet, "/snapshot", nil))

	var snapshot model.Snapshot

	if err := json.Unmarshal(snapshotResponse.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode pending snapshot: %v", err)
	}

	if snapshot.Diagnostics.Utility.Version != nil {
		t.Fatalf("pending utility version = %q, want unknown", *snapshot.Diagnostics.Utility.Version)
	}

	closeContext, cancelClose := context.WithTimeout(context.Background(), 50*time.Millisecond)

	defer cancelClose()

	if err := controller.Close(closeContext); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	select {
	case <-probeCanceled:
	case <-time.After(50 * time.Millisecond):
		t.Fatal("Close() did not cancel startup version probe")
	}

	select {
	case <-runDone:
	case <-time.After(50 * time.Millisecond):
		t.Fatal("controller Run() did not stop after Close()")
	}
}
