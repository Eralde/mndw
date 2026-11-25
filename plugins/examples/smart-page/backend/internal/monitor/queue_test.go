package monitor

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"smart-page/internal/model"
)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *testClock) Now() time.Time {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	return clock.now
}

func (clock *testClock) After(duration time.Duration) <-chan time.Time {
	result := make(chan time.Time, 1)
	result <- clock.Now().Add(duration)

	return result
}

func (clock *testClock) Advance(duration time.Duration) {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	clock.now = clock.now.Add(duration)
}

type executorCall struct {
	mode string
}

type blockingExecutor struct {
	started   chan executorCall
	release   chan struct{}
	active    atomic.Int32
	maxActive atomic.Int32
}

type immediateExecutor struct{}

func (immediateExecutor) Run(context.Context, model.Command) model.CommandResult {
	return model.CommandResult{ExitCode: 0}
}

func (immediateExecutor) Scan(context.Context) model.CommandResult {
	return model.CommandResult{Stdout: []byte(`{"devices":[]}`), ExitCode: 0}
}

func (immediateExecutor) ScanSCSI(context.Context) model.CommandResult {
	return model.CommandResult{Stdout: []byte(`{"devices":[]}`), ExitCode: 0}
}

type fixedResultExecutor struct {
	result model.CommandResult
}

func (executor fixedResultExecutor) Run(context.Context, model.Command) model.CommandResult {
	return executor.result
}

func (executor fixedResultExecutor) Scan(context.Context) model.CommandResult {
	return executor.result
}

func (executor fixedResultExecutor) ScanSCSI(context.Context) model.CommandResult {
	return executor.result
}

func (executor *blockingExecutor) Run(ctx context.Context, command model.Command) model.CommandResult {
	return executor.wait(ctx, command.Mode)
}

func (executor *blockingExecutor) Scan(ctx context.Context) model.CommandResult {
	return executor.wait(ctx, "scan")
}

func (executor *blockingExecutor) ScanSCSI(ctx context.Context) model.CommandResult {
	return executor.wait(ctx, "scan-scsi")
}

func (executor *blockingExecutor) wait(ctx context.Context, mode string) model.CommandResult {
	active := executor.active.Add(1)

	defer executor.active.Add(-1)

	for current := executor.maxActive.Load(); active > current; current = executor.maxActive.Load() {
		if executor.maxActive.CompareAndSwap(current, active) {
			break
		}
	}

	executor.started <- executorCall{mode: mode}

	select {
	case <-executor.release:
		return model.CommandResult{ExitCode: 0}
	case <-ctx.Done():
		return model.CommandResult{Failure: model.FailureCanceled, ExitCode: -1}
	}
}

func TestQueueBoundsCoalescingPriority(t *testing.T) {
	clock := &testClock{now: time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)}
	executor := &blockingExecutor{
		started: make(chan executorCall, MaxQueuedOperations+1),
		release: make(chan struct{}),
	}
	controller := New(Dependencies{Executor: executor, Clock: clock})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	original, err := controller.SubmitDiscover()
	if err != nil {
		t.Fatal(err)
	}

	select {
	case call := <-executor.started:
		if call.mode != "scan" {
			t.Fatalf("first executor call = %q, want scan", call.mode)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not start discovery")
	}

	duplicate, err := controller.SubmitDiscover()
	if err != nil || duplicate.ID != original.ID {
		t.Fatalf("running discovery coalesce = (%q, %v), want %q", duplicate.ID, err, original.ID)
	}

	queued := make([]model.Operation, 0, MaxQueuedOperations)

	for index := range MaxQueuedOperations {
		deviceID := model.ID(fmt.Sprintf("device-%02d", index))
		operation, submitErr := controller.enqueue(
			model.OperationRefresh,
			&deviceID,
			model.Command{Target: model.Target{Path: "/dev/test", Type: "sat"}, Mode: "manual"},
		)

		if submitErr != nil {
			t.Fatalf("enqueue device %s: %v", deviceID, submitErr)
		}

		queued = append(queued, operation)
	}

	duplicate, err = controller.enqueue(
		model.OperationRefresh,
		idPointer("device-00"),
		model.Command{Mode: "manual"},
	)
	if err != nil || duplicate.ID != queued[0].ID {
		t.Fatalf("queued refresh coalesce at full queue = (%q, %v), want %q", duplicate.ID, err, queued[0].ID)
	}

	_, err = controller.enqueue(
		model.OperationRefresh,
		idPointer("device-00"),
		model.Command{Mode: "standby"},
	)
	if admissionCode(err) != "busy" {
		t.Fatalf("different mode for pending device error = %v, want busy", err)
	}

	deviceID := model.ID("device-00")
	_, err = controller.enqueue(model.OperationDiscover, &deviceID, model.Command{Mode: "scan"})
	if admissionCode(err) != "busy" {
		t.Fatalf("conflicting device operation error = %v, want busy", err)
	}

	newDeviceID := model.ID("device-overflow")
	_, err = controller.enqueue(model.OperationRefresh, &newDeviceID, model.Command{Mode: "manual"})
	if admissionCode(err) != "queue-full" {
		t.Fatalf("new operation at full queue error = %v, want queue-full", err)
	}

	for _, operation := range queued {
		current, operationErr := controller.Operation(string(operation.ID))

		if operationErr != nil || current.Status != model.OperationQueued {
			t.Fatalf("operation %s while worker is busy = (%q, %v), want queued", operation.ID, current.Status, operationErr)
		}
	}

	closeContext, closeCancel := context.WithTimeout(context.Background(), time.Second)

	defer closeCancel()

	if err := controller.Close(closeContext); err != nil {
		t.Fatal(err)
	}

	if got := executor.maxActive.Load(); got != 1 {
		t.Fatalf("max executor concurrency = %d, want 1", got)
	}

	for _, operation := range append([]model.Operation{original}, queued...) {
		current, operationErr := controller.Operation(string(operation.ID))

		if operationErr != nil || current.Status != model.OperationCancelled {
			t.Errorf("operation %s after close = (%q, %v), want cancelled", operation.ID, current.Status, operationErr)
		}
	}
}

func TestOperationEviction(t *testing.T) {
	clock := &testClock{now: time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)}
	controller := New(Dependencies{Executor: immediateExecutor{}, Clock: clock})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	defer controller.Close(context.Background())

	operations := make([]model.Operation, 0, MaxCompletedOperations+1)

	for range MaxCompletedOperations + 1 {
		deviceID := model.ID(fmt.Sprintf("device-%02d", len(operations)))
		operation, err := controller.enqueue(
			model.OperationRefresh,
			&deviceID,
			model.Command{Target: model.Target{Path: "/dev/test", Type: "sat"}, Mode: "manual"},
		)
		if err != nil {
			t.Fatal(err)
		}

		waitForTerminalOperation(t, controller, operation.ID)

		operations = append(operations, operation)
	}

	if _, err := controller.Operation(string(operations[0].ID)); admissionCode(err) != "unknown-operation" {
		t.Fatalf("oldest operation after capacity eviction error = %v, want unknown-operation", err)
	}

	if _, err := controller.Operation(string(operations[len(operations)-1].ID)); err != nil {
		t.Fatalf("newest operation lookup: %v", err)
	}

	clock.Advance(OperationRetention - time.Millisecond)

	if _, err := controller.Operation(string(operations[len(operations)-1].ID)); err != nil {
		t.Fatalf("operation just before TTL expiry: %v", err)
	}

	clock.Advance(time.Millisecond)

	if _, err := controller.Operation(string(operations[len(operations)-1].ID)); admissionCode(err) != "unknown-operation" {
		t.Fatalf("operation after TTL error = %v, want unknown-operation", err)
	}

	restarted := New(Dependencies{Clock: clock})

	if _, err := restarted.Operation(string(operations[len(operations)-1].ID)); admissionCode(err) != "unknown-operation" {
		t.Fatalf("operation after controller restart error = %v, want unknown-operation", err)
	}
}

func TestOutputLimitFailsOperation(t *testing.T) {
	controller := New(Dependencies{Executor: fixedResultExecutor{
		result: model.CommandResult{Failure: model.FailureOutputLimit, ExitCode: -1},
	}})
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	go controller.Run(ctx)

	defer controller.Close(context.Background())

	operation, err := controller.SubmitDiscover()
	if err != nil {
		t.Fatal(err)
	}

	completed := waitForTerminalOperation(t, controller, operation.ID)

	if completed.Status != model.OperationFailed || completed.Error == nil || completed.Error.Code != "output-limit" {
		t.Fatalf("output-limit operation = %+v, want failed/output-limit", completed)
	}

	if completed.Result != nil || completed.CompletedAt == nil {
		t.Fatalf("output-limit operation = %+v, want completion time and no result", completed)
	}
}

func admissionCode(err error) string {
	if err == nil {
		return ""
	}

	var admission *AdmissionError

	if !errors.As(err, &admission) {
		return ""
	}

	return admission.Code
}

func waitForTerminalOperation(t *testing.T, controller *Controller, id model.ID) model.Operation {
	t.Helper()

	deadline := time.NewTimer(time.Second)

	defer deadline.Stop()

	for {
		operation, err := controller.Operation(string(id))
		if err != nil {
			t.Fatalf("operation %s lookup: %v", id, err)
		}

		if isTerminal(operation.Status) {
			return operation
		}

		select {
		case <-deadline.C:
			t.Fatalf("operation %s did not complete: %+v", id, operation)
		default:
			runtime.Gosched()
		}
	}
}

func idPointer(value string) *model.ID {
	id := model.ID(value)

	return &id
}
