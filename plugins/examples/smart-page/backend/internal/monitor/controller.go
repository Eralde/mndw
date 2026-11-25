package monitor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"smart-page/internal/devices"
	"smart-page/internal/diagnostics"
	"smart-page/internal/model"
)

var minimumValidClock = time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)

type Executor interface {
	Run(context.Context, model.Command) model.CommandResult
	Scan(context.Context) model.CommandResult
	ScanSCSI(context.Context) model.CommandResult
}

type Clock interface {
	Now() time.Time
	After(time.Duration) <-chan time.Time
}

type UtilityVersionProbe func(context.Context) (*model.Text, []model.Text)

type RealClock struct{}

func (RealClock) Now() time.Time {
	return time.Now()
}

func (RealClock) After(duration time.Duration) <-chan time.Time {
	return time.After(duration)
}

type Dependencies struct {
	Executor            Executor
	Clock               Clock
	Registry            *devices.Registry
	ProcessReader       diagnostics.ProcessReader
	Utility             model.UtilityDiagnostic
	DiagnosticReasons   []model.Text
	UtilityVersionProbe UtilityVersionProbe
}

type pendingOperation struct {
	operationID model.ID
	mode        string
}

type AdmissionError struct {
	Code string
}

func (admission *AdmissionError) Error() string {
	return admission.Code
}

type Controller struct {
	mu                  sync.Mutex
	executor            Executor
	registry            *devices.Registry
	clock               Clock
	processReader       diagnostics.ProcessReader
	utilityVersionProbe UtilityVersionProbe
	diagnosticReasons   []model.Text
	snapshot            model.Snapshot
	operations          map[model.ID]model.Operation
	completedAt         map[model.ID]time.Time
	queue               []queuedJob
	pendingByKey        map[string]pendingOperation
	refreshAdmissions   map[model.ID]bool
	completed           []model.ID
	wake                chan struct{}
	runDone             chan struct{}
	runCancel           context.CancelFunc
	runStarted          bool
	closed              bool
	discoveryRan        bool
	operationEpoch      string
}

var operationSequence atomic.Uint64

const MaxQueuedOperations = model.MaxQueuedOperations
const MaxCompletedOperations = model.MaxCompletedOperations
const OperationRetention = model.OperationRetention

func New(dependencies Dependencies) *Controller {
	clock := dependencies.Clock

	if clock == nil {
		clock = RealClock{}
	}

	now := clock.Now().UTC()
	checkedAt := dateTime(now)
	diagnostic := diagnostics.Pending(now)
	diagnostic.Utility = dependencies.Utility
	diagnostic.Reasons = append(diagnostic.Reasons, dependencies.DiagnosticReasons...)
	diagnostic.Reasons = append(diagnostic.Reasons, "discovery-not-run")
	registry := dependencies.Registry

	if registry == nil {
		registry = devices.NewRegistry(nil, nil)
	}

	return &Controller{
		executor:            dependencies.Executor,
		registry:            registry,
		clock:               clock,
		processReader:       dependencies.ProcessReader,
		utilityVersionProbe: dependencies.UtilityVersionProbe,
		diagnosticReasons:   append([]model.Text{}, dependencies.DiagnosticReasons...),
		snapshot: model.Snapshot{
			SchemaVersion:         1,
			ServerNow:             checkedAt,
			ClockStatus:           clockStatus(now),
			Devices:               make([]model.Device, 0),
			Diagnostics:           diagnostic,
			Truncated:             false,
			DisconnectedTruncated: false,
		},
		operations:        make(map[model.ID]model.Operation),
		completedAt:       make(map[model.ID]time.Time),
		pendingByKey:      make(map[string]pendingOperation),
		refreshAdmissions: make(map[model.ID]bool),
		wake:              make(chan struct{}, 1),
		runDone:           make(chan struct{}),
		operationEpoch:    newOperationEpoch(),
	}
}

func (controller *Controller) Run(ctx context.Context) {
	controller.mu.Lock()

	if controller.runStarted || controller.closed {
		controller.mu.Unlock()

		return
	}

	controller.runStarted = true
	runContext, cancel := context.WithCancel(ctx)
	controller.runCancel = cancel

	controller.mu.Unlock()

	defer close(controller.runDone)

	startupDone := make(chan struct{})

	go func() {
		defer close(startupDone)

		controller.runStartupDiagnostics(runContext)
	}()

	controller.worker(runContext)
	<-startupDone
}

func (controller *Controller) runStartupDiagnostics(ctx context.Context) {
	controller.mu.Lock()

	utility := controller.snapshot.Diagnostics.Utility

	controller.mu.Unlock()

	reasons := make([]model.Text, 0)

	if controller.utilityVersionProbe != nil {
		version, probeReasons := controller.utilityVersionProbe(ctx)
		utility.Version = version
		reasons = append(reasons, probeReasons...)
	}

	if ctx.Err() != nil {
		return
	}

	diagnostic := diagnostics.Check(controller.processReader, os.Getpid(), controller.clock.Now())

	if ctx.Err() != nil {
		return
	}

	diagnostic.Utility = utility
	diagnostic.Reasons = append(diagnostic.Reasons, controller.diagnosticReasons...)
	diagnostic.Reasons = append(diagnostic.Reasons, reasons...)

	controller.mu.Lock()

	defer controller.mu.Unlock()

	if controller.closed || ctx.Err() != nil {
		return
	}

	controller.snapshot.Diagnostics = diagnostic

	controller.syncRegistrySnapshotLocked()
}

func (controller *Controller) Close(ctx context.Context) error {
	controller.mu.Lock()

	controller.closed = true
	cancel := controller.runCancel
	runStarted := controller.runStarted

	controller.cancelQueuedLocked()

	controller.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	if !runStarted {
		return nil
	}

	select {
	case <-controller.runDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (controller *Controller) SubmitDiscover() (model.Operation, error) {
	if controller.executor == nil {
		return model.Operation{}, &AdmissionError{Code: "utility-unavailable"}
	}

	return controller.enqueue(model.OperationDiscover, nil, model.Command{Mode: "scan"})
}

func (controller *Controller) SubmitRefresh(deviceID string) (model.Operation, error) {
	if deviceID == "" {
		return model.Operation{}, &AdmissionError{Code: "bad-request"}
	}

	if controller.executor == nil {
		return model.Operation{}, &AdmissionError{Code: "utility-unavailable"}
	}

	id := model.ID(deviceID)

	controller.mu.Lock()

	if controller.closed {
		controller.mu.Unlock()

		return model.Operation{}, &AdmissionError{Code: "service-stopping"}
	}

	if controller.refreshAdmissions[id] {
		controller.mu.Unlock()

		return model.Operation{}, &AdmissionError{Code: "busy"}
	}

	controller.refreshAdmissions[id] = true

	controller.mu.Unlock()

	target, err := controller.registry.Target(deviceID)
	if err != nil {
		controller.mu.Lock()
		delete(controller.refreshAdmissions, id)
		controller.mu.Unlock()

		code := devices.ErrorCode(err)

		if code == "" {
			code = "unknown-device"
		}

		return model.Operation{}, &AdmissionError{Code: code}
	}

	controller.mu.Lock()
	delete(controller.refreshAdmissions, id)

	operation, enqueueErr := controller.enqueueLocked(model.OperationRefresh, &id, model.Command{
		Mode:   "manual",
		Target: target,
	})

	controller.mu.Unlock()

	return operation, enqueueErr
}

func (controller *Controller) SetDeviceType(deviceID string, deviceType *string) (model.DeviceTypeResponse, error) {
	controller.mu.Lock()

	defer controller.mu.Unlock()

	id := model.ID(deviceID)
	key := "device:" + deviceID

	if _, pending := controller.pendingByKey[key]; pending || controller.refreshAdmissions[id] {
		return model.DeviceTypeResponse{}, &AdmissionError{Code: "busy"}
	}

	response, err := controller.registry.SetDeviceType(deviceID, deviceType)
	if err != nil {
		code := devices.ErrorCode(err)

		if code == "" {
			code = "bad-request"
		}

		return model.DeviceTypeResponse{}, &AdmissionError{Code: code}
	}

	return response, nil
}

func (controller *Controller) Operation(id string) (model.Operation, error) {
	if !validOperationID(id) {
		return model.Operation{}, &AdmissionError{Code: "bad-request"}
	}

	controller.mu.Lock()

	defer controller.mu.Unlock()

	controller.pruneCompletedLocked()

	operation, exists := controller.operations[model.ID(id)]

	if !exists {
		return model.Operation{}, &AdmissionError{Code: "unknown-operation"}
	}

	return cloneOperation(operation), nil
}

func (controller *Controller) Snapshot() model.Snapshot {
	controller.mu.Lock()

	defer controller.mu.Unlock()

	controller.syncRegistrySnapshotLocked()

	snapshot := cloneSnapshot(controller.snapshot)
	now := controller.clock.Now().UTC()
	snapshot.ServerNow = dateTime(now)
	snapshot.ClockStatus = clockStatus(now)

	return snapshot
}

func (controller *Controller) syncRegistrySnapshotLocked() {
	devices, truncated, disconnectedTruncated := controller.registry.VisibleDevices()
	controller.snapshot.Devices = devices
	controller.snapshot.Truncated = truncated
	controller.snapshot.DisconnectedTruncated = disconnectedTruncated

	reasons := controller.snapshot.Diagnostics.Reasons[:0]

	for _, reason := range controller.snapshot.Diagnostics.Reasons {
		if controller.discoveryRan && reason == "discovery-not-run" {
			continue
		}

		reasons = append(reasons, reason)
	}

	if !controller.discoveryRan {
		found := false

		for _, reason := range reasons {
			if reason == "discovery-not-run" {
				found = true

				break
			}
		}

		if !found {
			reasons = append(reasons, "discovery-not-run")
		}
	}

	controller.snapshot.Diagnostics.Reasons = reasons
}

func (controller *Controller) enqueue(kind model.OperationKind, deviceID *model.ID, command model.Command) (model.Operation, error) {
	controller.mu.Lock()

	defer controller.mu.Unlock()

	return controller.enqueueLocked(kind, deviceID, command)
}

func (controller *Controller) enqueueLocked(kind model.OperationKind, deviceID *model.ID, command model.Command) (model.Operation, error) {

	controller.pruneCompletedLocked()

	if controller.closed {
		return model.Operation{}, &AdmissionError{Code: "service-stopping"}
	}

	key := operationKey(kind, deviceID)

	if existingPending, pending := controller.pendingByKey[key]; pending {
		existing := controller.operations[existingPending.operationID]

		if existing.Kind == kind && sameDeviceID(existing.DeviceID, deviceID) && existingPending.mode == command.Mode {
			return cloneOperation(existing), nil
		}

		return model.Operation{}, &AdmissionError{Code: "busy"}
	}

	if len(controller.queue) >= model.MaxQueuedOperations {
		return model.Operation{}, &AdmissionError{Code: "queue-full"}
	}

	operation := model.Operation{
		SchemaVersion: 1,
		ID:            controller.nextOperationIDLocked(),
		Kind:          kind,
		DeviceID:      cloneID(deviceID),
		Status:        model.OperationQueued,
		CreatedAt:     dateTime(controller.clock.Now()),
	}
	controller.operations[operation.ID] = operation
	controller.pendingByKey[key] = pendingOperation{operationID: operation.ID, mode: command.Mode}
	controller.queue = append(controller.queue, queuedJob{
		operationID: operation.ID,
		deviceID:    cloneID(deviceID),
		key:         key,
		kind:        kind,
		command:     command,
	})

	controller.signalWorker()

	return cloneOperation(operation), nil
}

func (controller *Controller) nextOperationIDLocked() model.ID {
	sequence := operationSequence.Add(1)

	return model.ID(fmt.Sprintf("%s-%x", controller.operationEpoch, sequence))
}

func (controller *Controller) signalWorker() {
	select {
	case controller.wake <- struct{}{}:
	default:
	}
}

func operationKey(kind model.OperationKind, deviceID *model.ID) string {
	if kind == model.OperationDiscover && deviceID == nil {
		return "discover"
	}

	if deviceID != nil {
		return "device:" + string(*deviceID)
	}

	return string(kind)
}

func sameDeviceID(left *model.ID, right *model.ID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}

	return *left == *right
}

func cloneID(value *model.ID) *model.ID {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}

func cloneOperation(operation model.Operation) model.Operation {
	operation.DeviceID = cloneID(operation.DeviceID)

	if operation.CompletedAt != nil {
		completedAt := *operation.CompletedAt
		operation.CompletedAt = &completedAt
	}

	if operation.Error != nil {
		detail := *operation.Error
		operation.Error = &detail
	}

	switch result := operation.Result.(type) {
	case model.DiscoverResult:
		result.DeviceIDs = append([]model.ID{}, result.DeviceIDs...)
		operation.Result = result
	case model.RefreshResult:
		operation.Result = result
	}

	return operation
}

func cloneSnapshot(snapshot model.Snapshot) model.Snapshot {
	snapshot.Devices = append([]model.Device{}, snapshot.Devices...)
	snapshot.Diagnostics.Groups = append([]uint32{}, snapshot.Diagnostics.Groups...)
	snapshot.Diagnostics.Reasons = append([]model.Text{}, snapshot.Diagnostics.Reasons...)

	if snapshot.Diagnostics.Utility.Path != nil {
		value := *snapshot.Diagnostics.Utility.Path
		snapshot.Diagnostics.Utility.Path = &value
	}

	if snapshot.Diagnostics.Utility.Version != nil {
		value := *snapshot.Diagnostics.Utility.Version
		snapshot.Diagnostics.Utility.Version = &value
	}

	if snapshot.Diagnostics.Smartd.Reason != nil {
		value := *snapshot.Diagnostics.Smartd.Reason
		snapshot.Diagnostics.Smartd.Reason = &value
	}

	if snapshot.Config != nil {
		config := *snapshot.Config
		config.Devices = append([]model.DeviceConfig(nil), config.Devices...)
		snapshot.Config = &config
	}

	if snapshot.Persistence != nil {
		persistence := *snapshot.Persistence
		snapshot.Persistence = &persistence
	}

	return snapshot
}

func validOperationID(value string) bool {
	if value == "" || len(value) > model.MaxOperationIDBytes {
		return false
	}

	for index := 0; index < len(value); index++ {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}

	return true
}

func newOperationEpoch() string {
	value := make([]byte, 8)

	if _, err := rand.Read(value); err == nil {
		return "op-" + hex.EncodeToString(value)
	}

	return fmt.Sprintf("op-%x-%x", os.Getpid(), time.Now().UnixNano())
}

func dateTime(value time.Time) model.DateTime {
	return model.DateTime(value.UTC().Format(time.RFC3339))
}

func clockStatus(now time.Time) model.ClockStatus {
	if now.Before(minimumValidClock) {
		return model.ClockInvalid
	}

	return model.ClockValid
}

func admissionCodeForController(err error) string {
	var admission *AdmissionError

	if errors.As(err, &admission) {
		return admission.Code
	}

	return ""
}

func AdmissionCode(err error) string {
	return admissionCodeForController(err)
}

func statusForAdmission(err error) int {
	switch admissionCodeForController(err) {
	case "bad-request":
		return 400
	case "unknown-device", "unknown-operation":
		return 404
	case "busy", "disconnected", "revision-conflict", "identity-unreliable", "needs-validation", "identity-limit":
		return 409
	case "queue-full":
		return 429
	case "utility-unavailable":
		return 503
	case "service-stopping":
		return 503
	case "config-write-failed":
		return 507
	default:
		return 400
	}
}

func StatusForAdmission(err error) int {
	return statusForAdmission(err)
}

func (controller *Controller) pruneCompletedLocked() {
	now := controller.clock.Now()
	kept := controller.completed[:0]

	for _, id := range controller.completed {
		operation, exists := controller.operations[id]
		completedAt, hasCompletedAt := controller.completedAt[id]

		if !exists || operation.CompletedAt == nil || !hasCompletedAt {
			delete(controller.operations, id)
			delete(controller.completedAt, id)

			continue
		}

		if !now.Before(completedAt.Add(model.OperationRetention)) {
			delete(controller.operations, id)
			delete(controller.completedAt, id)

			continue
		}

		kept = append(kept, id)
	}

	controller.completed = kept

	for len(controller.completed) > model.MaxCompletedOperations {
		oldest := controller.completed[0]
		controller.completed = controller.completed[1:]

		delete(controller.operations, oldest)
		delete(controller.completedAt, oldest)
	}
}

func (controller *Controller) cancelQueuedLocked() {
	for _, job := range controller.queue {
		controller.finishLocked(job.operationID, model.OperationCancelled, nil, "service-stopping")
	}

	controller.queue = nil
}

func (controller *Controller) finishLocked(id model.ID, status model.OperationStatus, result model.OperationResult, errorCode string) {
	operation, exists := controller.operations[id]

	if !exists || isTerminal(operation.Status) {
		return
	}

	operation.Status = status
	operation.Result = result
	completedAt := controller.clock.Now()
	operation.CompletedAt = dateTimePointer(completedAt)
	controller.completedAt[id] = completedAt

	if errorCode != "" {
		operation.Error = &model.ErrorDetail{Code: model.Text(errorCode)}
	}

	controller.operations[id] = operation

	for key, pending := range controller.pendingByKey {
		if pending.operationID == id {
			delete(controller.pendingByKey, key)
		}
	}

	controller.completed = append(controller.completed, id)

	controller.pruneCompletedLocked()
}

func dateTimePointer(value time.Time) *model.DateTime {
	formatted := dateTime(value)

	return &formatted
}

func isTerminal(status model.OperationStatus) bool {
	return status == model.OperationSucceeded || status == model.OperationFailed || status == model.OperationCancelled
}
