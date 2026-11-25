package monitor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"smart-page/internal/devices"
	"smart-page/internal/model"
)

type monitorDeviceOS struct {
	mu             sync.Mutex
	bindings       map[string]devices.Binding
	blockPath      string
	inspectEntered chan struct{}
	inspectRelease chan struct{}
}

func (operatingSystem *monitorDeviceOS) Inspect(path string) (devices.Binding, error) {
	operatingSystem.mu.Lock()

	binding, exists := operatingSystem.bindings[path]
	shouldBlock := path == operatingSystem.blockPath && operatingSystem.inspectEntered != nil && operatingSystem.inspectRelease != nil
	entered := operatingSystem.inspectEntered
	release := operatingSystem.inspectRelease

	operatingSystem.mu.Unlock()

	if shouldBlock {
		entered <- struct{}{}

		<-release
	}

	if !exists {
		return devices.Binding{}, errors.New("device absent")
	}

	return binding, nil
}

type blockingMonitorDeviceOS struct {
	entered chan struct{}
	release chan struct{}
	binding devices.Binding
}

func (operatingSystem *blockingMonitorDeviceOS) Inspect(_ string) (devices.Binding, error) {
	operatingSystem.entered <- struct{}{}

	<-operatingSystem.release

	return operatingSystem.binding, nil
}

type racingMonitorDeviceOS struct {
	registry       *devices.Registry
	mutateDeviceID string
}

func (operatingSystem *racingMonitorDeviceOS) Inspect(path string) (devices.Binding, error) {
	if path == "/dev/sdb" {
		if _, err := operatingSystem.registry.Accept(operatingSystem.mutateDeviceID, model.Sample{}, 0); err != nil {
			return devices.Binding{}, err
		}
	}

	return devices.Binding{Path: path, Token: "token:" + path}, nil
}

type discoveryCall struct {
	name string
	cmd  model.Command
}

type discoveryExecutor struct {
	mu          sync.Mutex
	calls       []discoveryCall
	plain       model.CommandResult
	scsi        model.CommandResult
	manual      model.CommandResult
	callChannel chan discoveryCall
}

func (executor *discoveryExecutor) Run(_ context.Context, command model.Command) model.CommandResult {
	call := discoveryCall{name: "manual", cmd: command}

	executor.record(call)

	return executor.manual
}

func (executor *discoveryExecutor) Scan(context.Context) model.CommandResult {
	executor.record(discoveryCall{name: "plain"})

	return executor.plain
}

func (executor *discoveryExecutor) ScanSCSI(context.Context) model.CommandResult {
	executor.record(discoveryCall{name: "scsi"})

	return executor.scsi
}

func (executor *discoveryExecutor) record(call discoveryCall) {
	executor.mu.Lock()

	executor.calls = append(executor.calls, call)

	executor.mu.Unlock()

	if executor.callChannel != nil {
		executor.callChannel <- call
	}
}

func TestDiscoverRunsBothScansAndPublishesRegistryResult(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })
	executor := &discoveryExecutor{
		plain:       model.CommandResult{Stdout: []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), ExitCode: 0},
		scsi:        model.CommandResult{Stdout: []byte(`{"devices":[{"name":"/dev/sda","type":"scsi"}]}`), ExitCode: 0},
		callChannel: make(chan discoveryCall, 2),
	}
	controller := New(Dependencies{Executor: executor, Registry: registry})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitDiscover()
	if err != nil {
		t.Fatal(err)
	}

	waitForTerminalOperation(t, controller, operation.ID)

	calls := []string{(<-executor.callChannel).name, (<-executor.callChannel).name}

	if calls[0] != "plain" || calls[1] != "scsi" {
		t.Fatalf("scan order = %v, want [plain scsi]", calls)
	}

	completed, err := controller.Operation(string(operation.ID))
	if err != nil {
		t.Fatal(err)
	}

	result, ok := completed.Result.(model.DiscoverResult)

	if completed.Status != model.OperationSucceeded || !ok || len(result.DeviceIDs) != 1 || result.DeviceIDs[0] != "disk-1" || result.ExitCode != 0 {
		t.Fatalf("discovery operation = %+v result=%+v, want successful registry result", completed, result)
	}

	snapshot := controller.Snapshot()

	if len(snapshot.Devices) != 1 || snapshot.Devices[0].DeviceType != "sat" {
		t.Fatalf("snapshot devices = %+v, want plain-scan type precedence", snapshot.Devices)
	}

	for _, reason := range snapshot.Diagnostics.Reasons {
		if reason == "discovery-not-run" {
			t.Fatal("successful discovery retained discovery-not-run")
		}
	}
}

func TestDiscoverRunsSCSIAfterPlainFailureAndFailsOperation(t *testing.T) {
	executor := &discoveryExecutor{
		plain:       model.CommandResult{ExitCode: 2},
		scsi:        model.CommandResult{Stdout: []byte(`{"devices":[]}`), ExitCode: 0},
		callChannel: make(chan discoveryCall, 2),
	}
	controller := New(Dependencies{Executor: executor})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitDiscover()
	if err != nil {
		t.Fatal(err)
	}

	completed := waitForTerminalOperation(t, controller, operation.ID)
	calls := []string{(<-executor.callChannel).name, (<-executor.callChannel).name}

	if calls[0] != "plain" || calls[1] != "scsi" {
		t.Fatalf("scan order = %v, want [plain scsi]", calls)
	}

	if completed.Status != model.OperationFailed || completed.Error == nil || completed.Error.Code != "command-failed" || completed.Result != nil {
		t.Fatalf("failed plain scan operation = %+v, want failed/command-failed", completed)
	}
}

func TestDiscoverInspectionRaceExhaustionFailsCommandFailed(t *testing.T) {
	operatingSystem := &racingMonitorDeviceOS{}
	registry := devices.NewRegistry(operatingSystem, func() string { return "device-a" })
	operatingSystem.registry = registry

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	ids, _ := registry.CurrentIDs()
	operatingSystem.mutateDeviceID = string(ids[0])
	executor := &discoveryExecutor{
		plain: model.CommandResult{Stdout: []byte(`{"devices":[{"name":"/dev/sdb","type":"sat"}]}`), ExitCode: 0},
		scsi:  model.CommandResult{Stdout: []byte(`{}`), ExitCode: 0},
	}
	controller := New(Dependencies{Executor: executor, Registry: registry})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitDiscover()
	if err != nil {
		t.Fatal(err)
	}

	completed := waitForTerminalOperation(t, controller, operation.ID)

	if completed.Status != model.OperationFailed || completed.Error == nil || completed.Error.Code != "command-failed" || completed.Result != nil {
		t.Fatalf("repeated discovery inspection race = %+v, want failed/command-failed", completed)
	}

	ids, _ = registry.CurrentIDs()

	if len(ids) != 1 || ids[0] != "device-a" {
		t.Fatalf("current IDs after exhausted discovery retries = %v, want unchanged [device-a]", ids)
	}
}

func TestRefreshAcceptsPlausibleSampleWithNonzeroExit(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	fixture, err := os.ReadFile(filepath.Join("..", "..", "testdata", "scsi-usb-nvme.json"))
	if err != nil {
		t.Fatalf("read smartctl fixture: %v", err)
	}

	clock := &testClock{now: time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)}
	executor := &discoveryExecutor{manual: model.CommandResult{Stdout: fixture, ExitCode: 4}, callChannel: make(chan discoveryCall, 1)}
	controller := New(Dependencies{Executor: executor, Registry: registry, Clock: clock})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitRefresh("disk-1")
	if err != nil {
		t.Fatal(err)
	}

	call := <-executor.callChannel

	if call.name != "manual" || call.cmd.Mode != "manual" || call.cmd.Target.Path != "/dev/sda" || call.cmd.Target.Type != "sat" || call.cmd.Target.BindingToken != "device-token" {
		t.Fatalf("refresh command = %+v, want current registry target", call)
	}

	completed := waitForTerminalOperation(t, controller, operation.ID)
	result, ok := completed.Result.(model.RefreshResult)

	if completed.Status != model.OperationSucceeded || !ok || !result.SampleAccepted || result.DeviceID != "disk-1" || result.ExitCode != 4 {
		t.Fatalf("refresh operation = %+v result=%+v, want accepted sample with exit code 4", completed, result)
	}

	device := controller.Snapshot().Devices[0]
	wantAt := model.DateTime(clock.Now().Format(time.RFC3339Nano))

	if device.Sample == nil || device.Sample.Protocol != model.ProtocolSCSI || device.Sample.Health != model.HealthPassed || device.Binding != model.BindingValidated {
		t.Fatalf("accepted refresh device = %+v, want validated SCSI sample", device)
	}

	if device.Collection.Status != model.CollectionOK || device.Collection.ExitCode == nil || *device.Collection.ExitCode != 4 {
		t.Errorf("collection = %+v, want ok with actual exit code 4", device.Collection)
	}

	if device.Freshness.Stale || device.Freshness.LastAttemptAt == nil || *device.Freshness.LastAttemptAt != wantAt || device.Freshness.LastSuccessAt == nil || *device.Freshness.LastSuccessAt != wantAt {
		t.Errorf("freshness = %+v, want successful sample time %q", device.Freshness, wantAt)
	}
}

func TestInvalidWrongBridgeRefreshPreservesPreviousSample(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	goodOutput, err := os.ReadFile(filepath.Join("..", "..", "testdata", "ata-ssd.json"))
	if err != nil {
		t.Fatalf("read good fixture: %v", err)
	}

	badOutput, err := os.ReadFile(filepath.Join("..", "..", "testdata", "wrong-bridge.json"))
	if err != nil {
		t.Fatalf("read wrong-bridge fixture: %v", err)
	}

	clock := &testClock{now: time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)}
	executor := &discoveryExecutor{manual: model.CommandResult{Stdout: goodOutput, ExitCode: 0}}
	controller := New(Dependencies{Executor: executor, Registry: registry, Clock: clock})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	goodOperation, err := controller.SubmitRefresh("disk-1")
	if err != nil {
		t.Fatal(err)
	}

	goodCompleted := waitForTerminalOperation(t, controller, goodOperation.ID)

	if goodCompleted.Status != model.OperationSucceeded {
		t.Fatalf("seed refresh = %+v, want success", goodCompleted)
	}

	previousSample := controller.Snapshot().Devices[0].Sample

	if previousSample == nil || previousSample.Health != model.HealthPassed || previousSample.Assessment.Level != model.LevelNormal {
		t.Fatalf("seed sample = %+v, want passed/normal sample", previousSample)
	}

	previousSuccessAt := controller.Snapshot().Devices[0].Freshness.LastSuccessAt

	clock.Advance(time.Minute)

	executor.manual = model.CommandResult{Stdout: badOutput, ExitCode: 8}
	badOperation, err := controller.SubmitRefresh("disk-1")
	if err != nil {
		t.Fatal(err)
	}

	badCompleted := waitForTerminalOperation(t, controller, badOperation.ID)

	if badCompleted.Status != model.OperationFailed || badCompleted.Error == nil || badCompleted.Error.Code != "invalid-output" || badCompleted.Result != nil {
		t.Fatalf("wrong-bridge refresh = %+v, want failed/invalid-output with no result", badCompleted)
	}

	device := controller.Snapshot().Devices[0]

	if !reflect.DeepEqual(device.Sample, previousSample) || device.Sample.Health == model.HealthFailed || device.Sample.Assessment.Level == model.LevelCritical {
		t.Errorf("invalid refresh replaced previous good sample: got=%+v previous=%+v", device.Sample, previousSample)
	}

	if device.Collection.Status != model.CollectionInvalidOutput || device.Collection.ExitCode == nil || *device.Collection.ExitCode != 8 {
		t.Errorf("invalid refresh collection = %+v, want invalid-output with exit code 8", device.Collection)
	}

	if !device.Freshness.Stale || device.Freshness.LastSuccessAt == nil || previousSuccessAt == nil || *device.Freshness.LastSuccessAt != *previousSuccessAt {
		t.Errorf("invalid refresh freshness = %+v, want stale with previous success retained", device.Freshness)
	}
}

func TestRefreshRunnerFailureWinsOverPlausibleOutput(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	validOutput, err := os.ReadFile(filepath.Join("..", "..", "testdata", "ata-ssd.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	executor := &discoveryExecutor{manual: model.CommandResult{Stdout: validOutput, ExitCode: 8, Failure: model.FailureTimeout}}
	controller := New(Dependencies{Executor: executor, Registry: registry})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitRefresh("disk-1")
	if err != nil {
		t.Fatal(err)
	}

	completed := waitForTerminalOperation(t, controller, operation.ID)

	if completed.Status != model.OperationFailed || completed.Error == nil || completed.Error.Code != "timeout" {
		t.Fatalf("runner failure result = %+v, want timeout", completed)
	}

	device := controller.Snapshot().Devices[0]

	if device.Sample != nil || device.Collection.Status != model.CollectionTimeout {
		t.Fatalf("runner failure device = %+v, want no sample and timeout collection", device)
	}
}

func TestRefreshAdmissionUsesRegistryState(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })
	controller := New(Dependencies{Executor: &discoveryExecutor{}, Registry: registry})

	if _, err := controller.SubmitRefresh("missing"); AdmissionCode(err) != "unknown-device" || StatusForAdmission(err) != 404 {
		t.Fatalf("unknown refresh admission = %v, want 404 unknown-device", err)
	}

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	operatingSystem.mu.Lock()
	delete(operatingSystem.bindings, "/dev/sda")
	operatingSystem.mu.Unlock()

	if _, err := controller.SubmitRefresh("disk-1"); AdmissionCode(err) != "disconnected" || StatusForAdmission(err) != 409 {
		t.Fatalf("disconnected refresh admission = %v, want 409 disconnected", err)
	}
}

func TestDeviceTypeAdmissionIsBusyDuringRefreshAdmission(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	operatingSystem.mu.Lock()

	operatingSystem.blockPath = "/dev/sda"
	operatingSystem.inspectEntered = make(chan struct{}, 1)
	operatingSystem.inspectRelease = make(chan struct{})
	entered := operatingSystem.inspectEntered
	release := operatingSystem.inspectRelease

	operatingSystem.mu.Unlock()

	executor := &discoveryExecutor{manual: model.CommandResult{ExitCode: 0}, callChannel: make(chan discoveryCall, 1)}
	controller := New(Dependencies{Executor: executor, Registry: registry})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	refreshResult := make(chan struct {
		operation model.Operation
		err       error
	}, 1)

	go func() {
		operation, err := controller.SubmitRefresh("disk-1")
		refreshResult <- struct {
			operation model.Operation
			err       error
		}{operation: operation, err: err}
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("refresh admission did not reach target inspection")
	}

	newType := "scsi"

	if _, err := controller.SetDeviceType("disk-1", &newType); AdmissionCode(err) != "busy" || StatusForAdmission(err) != 409 {
		t.Fatalf("SetDeviceType during refresh admission = %v, want 409 busy", err)
	}

	operatingSystem.mu.Lock()

	operatingSystem.blockPath = ""

	operatingSystem.mu.Unlock()
	close(release)

	var admitted struct {
		operation model.Operation
		err       error
	}

	select {
	case admitted = <-refreshResult:
	case <-time.After(time.Second):
		t.Fatal("refresh admission did not finish after inspection release")
	}

	if admitted.err != nil {
		t.Fatalf("SubmitRefresh() after release: %v", admitted.err)
	}

	call := <-executor.callChannel

	if call.cmd.Target.Type != "sat" {
		t.Fatalf("admitted refresh target type = %q, want old scan type sat", call.cmd.Target.Type)
	}

	waitForTerminalOperation(t, controller, admitted.operation.ID)
}

func TestRefreshOutputLimitMarksCollectionInvalid(t *testing.T) {
	operatingSystem := &monitorDeviceOS{bindings: map[string]devices.Binding{
		"/dev/sda": {Path: "/dev/sda", Token: "device-token"},
	}}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	executor := &discoveryExecutor{manual: model.CommandResult{Failure: model.FailureOutputLimit, ExitCode: -1}}
	controller := New(Dependencies{Executor: executor, Registry: registry})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitRefresh("disk-1")
	if err != nil {
		t.Fatal(err)
	}

	completed := waitForTerminalOperation(t, controller, operation.ID)

	if completed.Status != model.OperationFailed || completed.Error == nil || completed.Error.Code != "output-limit" {
		t.Fatalf("refresh output-limit operation = %+v", completed)
	}

	device := controller.Snapshot().Devices[0]

	if device.Collection.Status != model.CollectionInvalidOutput || device.Sample != nil {
		t.Fatalf("refresh output-limit device = %+v, want invalid-output and no sample", device)
	}
}

func TestSnapshotAndOperationLookupStayResponsiveDuringInspection(t *testing.T) {
	operatingSystem := &blockingMonitorDeviceOS{
		entered: make(chan struct{}, 1),
		release: make(chan struct{}),
		binding: devices.Binding{Path: "/dev/sda", Token: "device-token"},
	}
	registry := devices.NewRegistry(operatingSystem, func() string { return "disk-1" })
	executor := &discoveryExecutor{
		plain: model.CommandResult{Stdout: []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), ExitCode: 0},
		scsi:  model.CommandResult{Stdout: []byte(`{}`), ExitCode: 0},
	}
	controller := New(Dependencies{Executor: executor, Registry: registry})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	operation, err := controller.SubmitDiscover()
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-operatingSystem.entered:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("discovery did not enter OS inspection")
	}

	var releaseOnce sync.Once
	releaseInspection := func() {
		releaseOnce.Do(func() {
			close(operatingSystem.release)
		})
	}

	t.Cleanup(releaseInspection)

	snapshotDone := make(chan struct{})
	operationDone := make(chan struct{})

	go func() {
		controller.Snapshot()
		close(snapshotDone)
	}()

	go func() {
		_, _ = controller.Operation(string(operation.ID))

		close(operationDone)
	}()

	deadline := time.After(100 * time.Millisecond)

	for _, completed := range []<-chan struct{}{snapshotDone, operationDone} {
		select {
		case <-completed:
		case <-deadline:
			t.Fatal("snapshot or operation lookup waited for OS inspection")
		}
	}

	releaseInspection()
	waitForTerminalOperation(t, controller, operation.ID)
}
