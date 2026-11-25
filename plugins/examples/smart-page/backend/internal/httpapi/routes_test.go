package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"smart-page/internal/devices"
	"smart-page/internal/model"
	"smart-page/internal/monitor"
)

type routeExecutor struct {
	calls      atomic.Int32
	started    chan struct{}
	release    chan struct{}
	scanResult model.CommandResult
}

type routeDeviceOS struct {
	bindings map[string]devices.Binding
}

func (operatingSystem *routeDeviceOS) Inspect(path string) (devices.Binding, error) {
	binding, exists := operatingSystem.bindings[path]

	if !exists {
		return devices.Binding{}, fmt.Errorf("device absent")
	}

	return binding, nil
}

func (executor *routeExecutor) Run(ctx context.Context, _ model.Command) model.CommandResult {
	executor.calls.Add(1)

	return model.CommandResult{ExitCode: 0}
}

func (executor *routeExecutor) Scan(ctx context.Context) model.CommandResult {
	executor.calls.Add(1)

	if executor.started != nil {
		executor.started <- struct{}{}
	}

	if executor.release != nil {
		select {
		case <-executor.release:
		case <-ctx.Done():
			return model.CommandResult{Failure: model.FailureCanceled, ExitCode: -1}
		}
	}

	return executor.scanResult
}

func (executor *routeExecutor) ScanSCSI(ctx context.Context) model.CommandResult {
	return executor.Scan(ctx)
}

func TestPrivateRoutes(t *testing.T) {
	executor := &routeExecutor{
		started:    make(chan struct{}, 1),
		release:    make(chan struct{}),
		scanResult: model.CommandResult{Failure: model.FailurePermissionDenied, ExitCode: -1},
	}
	controller := monitor.New(monitor.Dependencies{Executor: executor})
	serviceContext, stopService := context.WithCancel(context.Background())

	defer stopService()

	go controller.Run(serviceContext)

	handler := New(controller, "smart-page", 1)

	for _, body := range []string{
		`{}`,
		`{"acknowledgeWake":false}`,
		`{"ACKNOWLEDGEWAKE":true}`,
		`{"AcknowledgeWake":true}`,
		`{"acknowledgeWake":true,"command":"smartctl"}`,
		`{"acknowledgeWake":true}{}`,
		fmt.Sprintf(`{"acknowledgeWake":true,"extra":"%s"}`, strings.Repeat("x", 16<<10)),
	} {
		response := serveJSON(handler, http.MethodPost, "/discover", body)

		assertAPIError(t, response, http.StatusBadRequest, "bad-request")
	}

	badCaseRefresh := serveJSON(handler, http.MethodPost, "/refresh", `{"DeviceId":"unknown","acknowledgeWake":true}`)

	assertAPIError(t, badCaseRefresh, http.StatusBadRequest, "bad-request")

	unknownRefresh := serveJSON(handler, http.MethodPost, "/refresh", `{"deviceId":"unknown","acknowledgeWake":true}`)

	assertAPIError(t, unknownRefresh, http.StatusNotFound, "unknown-device")

	unknownOperation := httptest.NewRecorder()

	handler.ServeHTTP(unknownOperation, httptest.NewRequest(http.MethodGet, "/operation?id=missing", nil))
	assertAPIError(t, unknownOperation, http.StatusNotFound, "unknown-operation")

	requestContext, cancelRequest := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPost, "/discover", strings.NewReader(`{"acknowledgeWake":true}`)).WithContext(requestContext)
	acceptedResponse := httptest.NewRecorder()

	handler.ServeHTTP(acceptedResponse, request)

	if acceptedResponse.Code != http.StatusAccepted {
		t.Fatalf("discover status = %d, want %d: %s", acceptedResponse.Code, http.StatusAccepted, acceptedResponse.Body.String())
	}

	if acceptedResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("discover cache control = %q, want no-store", acceptedResponse.Header().Get("Cache-Control"))
	}

	var accepted model.AcceptedOperation

	if err := json.Unmarshal(acceptedResponse.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("decode accepted operation: %v", err)
	}

	if accepted.SchemaVersion != 1 || accepted.OperationID == "" {
		t.Fatalf("accepted operation = %+v, want schema version 1 and non-empty ID", accepted)
	}

	select {
	case <-executor.started:
	case <-time.After(time.Second):
		t.Fatal("accepted discovery did not reach executor")
	}

	cancelRequest()
	close(executor.release)

	deadline := time.After(time.Second)

	for {
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/operation?id="+string(accepted.OperationID), nil))

		if response.Code != http.StatusOK {
			t.Fatalf("operation status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
		}

		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("operation cache control = %q, want no-store", response.Header().Get("Cache-Control"))
		}

		var operation model.Operation

		if err := json.Unmarshal(response.Body.Bytes(), &operation); err != nil {
			t.Fatalf("decode operation: %v", err)
		}

		if operation.Status == model.OperationFailed {
			if operation.CompletedAt == nil {
				t.Fatalf("operation after POST disconnect = %+v, want completed operation", operation)
			}

			break
		}

		if operation.Status != model.OperationQueued && operation.Status != model.OperationRunning {
			t.Fatalf("operation after POST disconnect = %+v, want running then terminal failure", operation)
		}

		select {
		case <-deadline:
			t.Fatalf("operation did not complete after POST disconnected: %+v", operation)
		default:
			runtime.Gosched()
		}
	}

}

func TestEmptyDiscoverySerializesDeviceIDsAsArray(t *testing.T) {
	executor := &routeExecutor{scanResult: model.CommandResult{Stdout: []byte(`{}`), ExitCode: 0}}
	controller := monitor.New(monitor.Dependencies{Executor: executor})
	serviceContext, stopService := context.WithCancel(context.Background())

	defer stopService()

	go controller.Run(serviceContext)

	handler := New(controller, "smart-page", 1)
	acceptedResponse := serveJSON(handler, http.MethodPost, "/discover", `{"acknowledgeWake":true}`)

	if acceptedResponse.Code != http.StatusAccepted {
		t.Fatalf("discover status = %d, want %d: %s", acceptedResponse.Code, http.StatusAccepted, acceptedResponse.Body.String())
	}

	var accepted model.AcceptedOperation

	if err := json.Unmarshal(acceptedResponse.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("decode accepted operation: %v", err)
	}

	deadline := time.After(time.Second)

	for {
		operation, err := controller.Operation(string(accepted.OperationID))
		if err != nil {
			t.Fatal(err)
		}

		if operation.Status == model.OperationSucceeded {
			break
		}

		select {
		case <-deadline:
			t.Fatalf("empty discovery operation did not succeed: %+v", operation)
		default:
			runtime.Gosched()
		}
	}

	response := serveJSON(handler, http.MethodGet, "/operation?id="+string(accepted.OperationID), "")

	if response.Code != http.StatusOK {
		t.Fatalf("operation status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}

	var envelope struct {
		Result json.RawMessage `json:"result"`
	}

	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode operation response: %v", err)
	}

	var result struct {
		DeviceIDs json.RawMessage `json:"deviceIds"`
	}

	if err := json.Unmarshal(envelope.Result, &result); err != nil {
		t.Fatalf("decode discover result: %v", err)
	}

	if string(result.DeviceIDs) != `[]` {
		t.Fatalf("HTTP discover result deviceIds = %s, want []", result.DeviceIDs)
	}
}

func TestReadyWithoutUtility(t *testing.T) {
	executor := &routeExecutor{scanResult: model.CommandResult{ExitCode: 0}}
	controller := monitor.New(monitor.Dependencies{Executor: executor})
	serviceContext, stopService := context.WithCancel(context.Background())

	defer stopService()

	go controller.Run(serviceContext)

	handler := New(controller, "smart-page", 1)

	for _, target := range []string{"/_mndw/ready", "/snapshot"} {
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))

		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want %d", target, response.Code, http.StatusOK)
		}
	}

	if got := executor.calls.Load(); got != 0 {
		t.Fatalf("startup and GET command calls = %d, want zero", got)
	}

	withoutUtility := New(monitor.New(monitor.Dependencies{}), "smart-page", 1)
	response := serveJSON(withoutUtility, http.MethodPost, "/discover", `{"acknowledgeWake":true}`)

	assertAPIError(t, response, http.StatusServiceUnavailable, "utility-unavailable")
}

func TestDeviceTypeRouteStatusCodes(t *testing.T) {
	largeBody := `{"deviceId":"disk-a","deviceType":"` + strings.Repeat("x", 16<<10) + `"}`
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
		disconnect bool
		busy       bool
		wantType   string
		wantSource model.DeviceTypeSource
	}{
		{name: "valid override", body: `{"deviceId":"disk-a","deviceType":"sntasmedia"}`, wantStatus: http.StatusOK, wantType: "sntasmedia", wantSource: model.DeviceTypeSourceUser},
		{name: "reset to scan type", body: `{"deviceId":"disk-a","deviceType":null}`, wantStatus: http.StatusOK, wantType: "sat", wantSource: model.DeviceTypeSourceScan},
		{name: "invalid value", body: `{"deviceId":"disk-a","deviceType":"future"}`, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "missing type", body: `{"deviceId":"disk-a"}`, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "missing device ID", body: `{"deviceType":"scsi"}`, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "wrong type", body: `{"deviceId":"disk-a","deviceType":1}`, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "wrong case", body: `{"DeviceId":"disk-a","deviceType":"scsi"}`, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "trailing JSON", body: `{"deviceId":"disk-a","deviceType":"scsi"}{}`, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "oversized body", body: largeBody, wantStatus: http.StatusBadRequest, wantCode: "bad-request"},
		{name: "unknown device", body: `{"deviceId":"missing","deviceType":null}`, wantStatus: http.StatusNotFound, wantCode: "unknown-device"},
		{name: "disconnected device", body: `{"deviceId":"disk-a","deviceType":"scsi"}`, wantStatus: http.StatusConflict, wantCode: "disconnected", disconnect: true},
		{name: "queued refresh", body: `{"deviceId":"disk-a","deviceType":"scsi"}`, wantStatus: http.StatusConflict, wantCode: "busy", busy: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operatingSystem := &routeDeviceOS{bindings: map[string]devices.Binding{
				"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
			}}
			registry := devices.NewRegistry(operatingSystem, func() string { return "disk-a" })

			if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
				t.Fatal(err)
			}

			controller := monitor.New(monitor.Dependencies{Executor: &routeExecutor{}, Registry: registry})

			if test.disconnect {
				if err := registry.Discover([]byte(`{"devices":[]}`), []byte(`{}`)); err != nil {
					t.Fatal(err)
				}
			}

			if test.busy {
				if _, err := controller.SubmitRefresh("disk-a"); err != nil {
					t.Fatalf("queue refresh: %v", err)
				}
			}

			response := serveJSON(New(controller, "smart-page", 1), http.MethodPost, "/device-type", test.body)

			if test.wantStatus != http.StatusOK {
				assertAPIError(t, response, test.wantStatus, test.wantCode)

				return
			}

			if response.Code != http.StatusOK {
				t.Fatalf("device-type status = %d, want 200: %s", response.Code, response.Body.String())
			}

			var got model.DeviceTypeResponse

			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode device-type response: %v", err)
			}

			if got.SchemaVersion != 1 || got.DeviceID != "disk-a" || got.DeviceType != model.Text(test.wantType) || got.DeviceTypeSource != test.wantSource {
				t.Fatalf("device-type response = %+v", got)
			}
		})
	}
}

func serveJSON(handler http.Handler, method string, path string, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))

	return response
}

func assertAPIError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()

	if response.Code != status {
		t.Fatalf("API status = %d, want %d: %s", response.Code, status, response.Body.String())
	}

	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("API cache control = %q, want no-store", response.Header().Get("Cache-Control"))
	}

	var apiError model.APIError

	if err := json.Unmarshal(response.Body.Bytes(), &apiError); err != nil {
		t.Fatalf("decode API error: %v", err)
	}

	if apiError.SchemaVersion != 1 || apiError.Error.Code != model.Text(code) {
		t.Fatalf("API error = %+v, want schema version 1 code %q", apiError, code)
	}
}
