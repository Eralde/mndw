package mgmt

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/state"
)

func TestBackendUploadUsesStoppedInstallLifecycleWithoutStarting(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	resp := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	}))

	defer resp.Body.Close()

	if resp.StatusCode != 202 {
		t.Fatalf("upload status = %d, want 202", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpInstalling, backend.IntentStop)

	for _, event := range runtime.events {
		if strings.HasPrefix(event, "start:") {
			t.Fatalf("backend upload started service: events=%v", runtime.events)
		}
	}
}

func TestApproveStartsDesiredSnapshotBeforePersistingApproval(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	})).Body.Close()

	runtime.calls = nil
	runtime.events = nil

	resp := postName(t, srv, "/api/mgmt/approve", "svc")

	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Fatalf("approve status = %d, want 200", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpInstalling, backend.IntentRun)

	if !containsString(runtime.events, "start:stored=pending/false:requested=approved/true") {
		t.Fatalf("approval activation order = %v", runtime.events)
	}

	record, ok := store.Get("svc")

	if !ok || record.Approval != state.ApprovalApproved || !record.Enabled {
		t.Fatalf("approved record = %+v, exists=%t", record, ok)
	}
}

func TestEnableStartsDesiredSnapshotBeforePersistingEnabled(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	})).Body.Close()
	postName(t, srv, "/api/mgmt/approve", "svc").Body.Close()
	postName(t, srv, "/api/mgmt/disable", "svc").Body.Close()

	runtime.calls = nil
	runtime.events = nil

	resp := postName(t, srv, "/api/mgmt/enable", "svc")

	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Fatalf("enable status = %d, want 200", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpStarting, backend.IntentRun)

	if !containsString(runtime.events, "start:stored=approved/false:requested=approved/true") {
		t.Fatalf("enable activation order = %v", runtime.events)
	}
}

func TestDisablePersistsDisabledWhenStopFails(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  backendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	})).Body.Close()
	postName(t, srv, "/api/mgmt/approve", "svc").Body.Close()

	runtime.calls = nil
	runtime.events = nil
	runtime.stopErr = errors.New("stop failed")

	resp := postName(t, srv, "/api/mgmt/disable", "svc")

	defer resp.Body.Close()

	if resp.StatusCode != 502 {
		t.Fatalf("disable status = %d, want 502", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpStopping, backend.IntentStop)

	record, ok := store.Get("svc")

	if !ok || record.Enabled {
		t.Fatalf("record after failed stop = %+v, exists=%t", record, ok)
	}
}

func TestDeletePersistsRemovalMarkerBeforeStopAndRetainsItOnCleanupFailure(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store, handler, _ := newLifecycleHarness(t, runtime, nil)
	runtime.store = store

	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json": noBackendManifest,
		"index.js":      "x",
	})).Body.Close()

	runtime.calls = nil
	runtime.events = nil
	runtime.stopHook = func() {
		record, ok := store.Get("hello")

		if !ok || !record.RemovalPending || record.Enabled {
			t.Fatalf("record at stop = %+v, exists=%t", record, ok)
		}
	}
	handler.removeAll = func(string) error {
		return errors.New("filesystem unavailable")
	}

	resp := postName(t, srv, "/api/mgmt/delete", "hello")

	defer resp.Body.Close()

	if resp.StatusCode != 500 {
		t.Fatalf("delete status = %d, want 500", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpDeleting, backend.IntentRemove)

	record, ok := store.Get("hello")

	if !ok || !record.RemovalPending || record.Enabled {
		t.Fatalf("record after failed cleanup = %+v, exists=%t", record, ok)
	}
}

func TestRestartUsesLifecycleStopThenStart(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  serviceBackendManifest,
		"index.js":       "x",
		"backend/run.sh": "#!/bin/sh\n",
	})).Body.Close()
	postName(t, srv, "/api/mgmt/approve", "svc").Body.Close()

	runtime.calls = nil
	runtime.events = nil

	resp := postName(t, srv, "/api/mgmt/restart", "svc")

	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Fatalf("restart status = %d, want 200", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpRestarting, backend.IntentRun)

	want := []string{"execute:3/0", "stop:stored=true", "start:stored=approved/true:requested=approved/true"}

	if len(runtime.events) != len(want) {
		t.Fatalf("restart events = %v, want %v", runtime.events, want)
	}

	for index := range want {
		if runtime.events[index] != want[index] {
			t.Fatalf("restart events = %v, want %v", runtime.events, want)
		}
	}
}

func TestUpdateLifecycleStartsNewSnapshot(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	installApprovedService(t, srv)

	runtime.calls = nil
	runtime.events = nil
	runtime.startVersions = nil

	resp := postUpdate(t, srv, "2.0.0", "new")

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update status = %d, want 200", resp.StatusCode)
	}

	assertLifecycleCall(t, runtime, backend.OpUpdating, backend.IntentRun)

	if len(runtime.startVersions) != 1 || runtime.startVersions[0] != "2.0.0" {
		t.Fatalf("update start versions = %v", runtime.startVersions)
	}

	record, _ := store.Get("svc")

	if record.Version != "2.0.0" || !record.Enabled {
		t.Fatalf("updated record = %+v", record)
	}
}

func TestUpdateFailureRestoresPriorSnapshotAndDurableState(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	installApprovedService(t, srv)

	runtime.calls = nil
	runtime.events = nil
	runtime.startVersions = nil
	runtime.startErrors = []error{errors.New("new readiness failed"), nil}

	resp := postUpdate(t, srv, "2.0.0", "new")

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("update status = %d, want 502", resp.StatusCode)
	}

	if len(runtime.startVersions) != 2 || runtime.startVersions[0] != "2.0.0" || runtime.startVersions[1] != "1.0.0" {
		t.Fatalf("rollback start versions = %v", runtime.startVersions)
	}

	record, _ := store.Get("svc")

	if record.Version != "1.0.0" || !record.Enabled {
		t.Fatalf("rolled-back record = %+v", record)
	}
}

func TestUpdateRollbackFailureLeavesPluginStoppedAndBlocked(t *testing.T) {
	runtime := &lifecycleTestRuntime{}
	srv, store := newLifecycleServer(t, runtime, nil)
	runtime.store = store

	installApprovedService(t, srv)

	runtime.calls = nil
	runtime.events = nil
	runtime.startVersions = nil
	runtime.startErrors = []error{errors.New("new readiness failed"), errors.New("prior restart failed")}

	resp := postUpdate(t, srv, "2.0.0", "new")

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("update status = %d, want 500", resp.StatusCode)
	}

	record, _ := store.Get("svc")

	if record.Enabled {
		t.Fatalf("rollback-failed record remained enabled: %+v", record)
	}

	if !runtime.BlocksTraffic("svc") {
		t.Fatal("rollback failure reopened plugin traffic")
	}
}

func installApprovedService(t *testing.T, srv *httptest.Server) {
	t.Helper()

	resp := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json":  serviceBackendManifest,
		"index.js":       "old",
		"backend/run.sh": "#!/bin/sh\n",
	}))

	resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("setup upload status = %d", resp.StatusCode)
	}

	resp = postName(t, srv, "/api/mgmt/approve", "svc")

	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("setup approve status = %d", resp.StatusCode)
	}
}

func postUpdate(t *testing.T, srv *httptest.Server, version, index string) *http.Response {
	t.Helper()

	manifestJSON := strings.Replace(serviceBackendManifest, `"1.0.0"`, `"`+version+`"`, 1)
	body := makeZip(t, map[string]string{
		"manifest.json":  manifestJSON,
		"index.js":       index,
		"backend/run.sh": "#!/bin/sh\n",
	})
	resp, err := http.Post(srv.URL+"/api/mgmt/update", "application/zip", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("update POST: %v", err)
	}

	return resp
}

func assertLifecycleCall(
	t *testing.T,
	runtime *lifecycleTestRuntime,
	op backend.Operation,
	intent backend.Intent,
) {
	t.Helper()

	if len(runtime.calls) != 1 {
		t.Fatalf("lifecycle calls = %+v, want one", runtime.calls)
	}

	call := runtime.calls[0]

	if call.op != op || call.intent != intent {
		t.Fatalf("lifecycle call = %+v", call)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}

	return false
}

func TestRemovalWatchdogWarnsWithPluginName(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	timer := make(chan time.Time, 1)
	timer <- time.Now()
	var logs bytes.Buffer
	h := &Handler{
		logger: slog.New(slog.NewTextHandler(&logs, nil)),
		removeAll: func(string) error {
			close(entered)
			<-release

			return nil
		},
		newTimer: func(time.Duration) <-chan time.Time {
			return timer
		},
		removalWatchdog: time.Minute,
	}
	done := make(chan error, 1)

	go func() {
		done <- h.removePluginFiles("slow-plugin", "/plugins/slow-plugin")
	}()

	<-entered
	close(release)

	if err := <-done; err != nil {
		t.Fatalf("removePluginFiles: %v", err)
	}

	output := logs.String()

	if !strings.Contains(output, "level=WARN") || !strings.Contains(output, "plugin=slow-plugin") || !strings.Contains(output, "removal phase exceeded watchdog") {
		t.Fatalf("watchdog log = %q", output)
	}
}

func TestRemovePluginFilesReturnsRemovalError(t *testing.T) {
	want := errors.New("remove failed")
	h := &Handler{
		logger: discardLogger(),
		removeAll: func(string) error {
			return want
		},
		newTimer: func(time.Duration) <-chan time.Time {
			return make(chan time.Time)
		},
		removalWatchdog: time.Minute,
	}

	if err := h.removePluginFiles("broken-plugin", "/plugins/broken-plugin"); !errors.Is(err, want) {
		t.Fatalf("removePluginFiles error = %v, want %v", err, want)
	}
}
