package monitor

import (
	"context"

	"smart-page/internal/devices"
	"smart-page/internal/model"
	"smart-page/internal/smartctl"
)

type queuedJob struct {
	operationID model.ID
	deviceID    *model.ID
	key         string
	kind        model.OperationKind
	command     model.Command
}

type execution struct {
	status    model.OperationStatus
	result    model.OperationResult
	errorCode string
}

func (controller *Controller) worker(ctx context.Context) {
	for {
		controller.mu.Lock()

		if ctx.Err() != nil {
			controller.closed = true

			controller.cancelQueuedLocked()
			controller.mu.Unlock()

			return
		}

		if len(controller.queue) == 0 {
			controller.mu.Unlock()

			select {
			case <-controller.wake:
			case <-ctx.Done():
			}

			continue
		}

		job := controller.queue[0]
		controller.queue[0] = queuedJob{}
		controller.queue = controller.queue[1:]
		operation := controller.operations[job.operationID]
		operation.Status = model.OperationRunning
		controller.operations[job.operationID] = operation

		controller.mu.Unlock()

		outcome := controller.execute(ctx, job)

		controller.mu.Lock()

		if ctx.Err() != nil {
			controller.finishLocked(job.operationID, model.OperationCancelled, nil, "service-stopping")
		} else {
			controller.finishLocked(job.operationID, outcome.status, outcome.result, outcome.errorCode)
		}

		controller.mu.Unlock()
	}
}

func (controller *Controller) execute(ctx context.Context, job queuedJob) execution {
	if job.kind == model.OperationDiscover {
		plain := controller.executor.Scan(ctx)
		scsi := controller.executor.ScanSCSI(ctx)

		if outcome, failed := commandOutcome(plain); failed {
			return outcome
		}

		if outcome, failed := commandOutcome(scsi); failed {
			return outcome
		}

		if err := controller.registry.Discover(plain.Stdout, scsi.Stdout); err != nil {
			if devices.IsInspectionRace(err) {
				return execution{status: model.OperationFailed, errorCode: "command-failed"}
			}

			code := devices.ErrorCode(err)

			if code == "" {
				code = "invalid-output"
			}

			return execution{status: model.OperationFailed, errorCode: code}
		}

		deviceIDs, truncated := controller.registry.CurrentIDs()

		controller.mu.Lock()

		controller.discoveryRan = true

		controller.syncRegistrySnapshotLocked()
		controller.mu.Unlock()

		return execution{
			status: model.OperationSucceeded,
			result: model.DiscoverResult{
				Kind:      model.OperationDiscover,
				DeviceIDs: deviceIDs,
				Truncated: truncated,
				ExitCode:  0,
			},
		}
	}

	command := job.command

	if command.Target.BindingToken != "" {
		if job.deviceID == nil {
			return execution{status: model.OperationFailed, errorCode: "unknown-device"}
		}

		target, err := controller.registry.Target(string(*job.deviceID))
		if err != nil {
			code := devices.ErrorCode(err)

			if code == "busy" {
				code = "command-failed"
			}

			if code == "" {
				code = "disconnected"
			}

			controller.refreshAttempt(job, collectionStatusForError(code), nil)

			return execution{status: model.OperationFailed, errorCode: code}
		}

		command.Target = target
	}

	result := controller.executor.Run(ctx, command)

	if result.Failure != "" {
		status, errorCode := operationOutcome(result)

		controller.refreshAttempt(job, collectionStatusForError(errorCode), intPointerIfKnown(result.ExitCode))

		return execution{status: status, errorCode: errorCode}
	}

	if result.ExitCode < 0 || result.ExitCode&0x3 != 0 {
		controller.refreshAttempt(job, model.CollectionCommandFailed, intPointerIfKnown(result.ExitCode))

		return execution{status: model.OperationFailed, errorCode: "command-failed"}
	}

	if job.deviceID == nil {
		return execution{status: model.OperationFailed, errorCode: "unknown-device"}
	}

	sample, err := smartctl.Decode(result, controller.clock.Now())
	if err != nil {
		controller.refreshAttempt(job, model.CollectionInvalidOutput, intPointerIfKnown(result.ExitCode))

		return execution{status: model.OperationFailed, errorCode: "invalid-output"}
	}

	accepted, err := controller.registry.Accept(string(*job.deviceID), sample, result.ExitCode)
	if err != nil {
		errorCode := registryErrorCode(err)

		controller.refreshAttempt(job, collectionStatusForError(errorCode), intPointerIfKnown(result.ExitCode))

		return execution{status: model.OperationFailed, errorCode: errorCode}
	}

	controller.mu.Lock()
	controller.syncRegistrySnapshotLocked()
	controller.mu.Unlock()

	return execution{
		status: model.OperationSucceeded,
		result: model.RefreshResult{
			Kind:           model.OperationRefresh,
			DeviceID:       accepted.DeviceID,
			ExitCode:       result.ExitCode,
			SampleAccepted: true,
		},
	}
}

func registryErrorCode(err error) string {
	if devices.IsInspectionRace(err) {
		return "command-failed"
	}

	code := devices.ErrorCode(err)

	if code == "busy" {
		return "command-failed"
	}

	if code == "" {
		return "command-failed"
	}

	return code
}

func (controller *Controller) refreshAttempt(job queuedJob, status model.CollectionStatus, exitCode *int) {
	if job.deviceID != nil {
		controller.registry.RecordAttempt(string(*job.deviceID), status, exitCode, dateTime(controller.clock.Now()))
	}

	controller.mu.Lock()
	controller.syncRegistrySnapshotLocked()
	controller.mu.Unlock()
}

func commandOutcome(result model.CommandResult) (execution, bool) {
	status, code, failed := commandOutcomeDetails(result)

	if !failed {
		return execution{}, false
	}

	return execution{status: status, errorCode: code}, true
}

func commandOutcomeDetails(result model.CommandResult) (model.OperationStatus, string, bool) {
	if result.Failure != "" {
		status, code := operationOutcome(result)

		return status, code, true
	}

	if result.ExitCode != 0 {
		return model.OperationFailed, "command-failed", true
	}

	return model.OperationSucceeded, "", false
}

func operationOutcome(result model.CommandResult) (model.OperationStatus, string) {
	switch result.Failure {
	case model.FailureOutputLimit:
		return model.OperationFailed, "output-limit"
	case model.FailurePermissionDenied:
		return model.OperationFailed, "permission-denied"
	case model.FailureTimeout:
		return model.OperationFailed, "timeout"
	case model.FailureCanceled:
		return model.OperationCancelled, "service-stopping"
	case model.FailureBinaryUnavailable:
		return model.OperationFailed, "utility-unavailable"
	case "disconnected":
		return model.OperationFailed, "disconnected"
	case "invalid-output":
		return model.OperationFailed, "invalid-output"
	default:
		return model.OperationFailed, "command-failed"
	}
}

func collectionStatusForError(code string) model.CollectionStatus {
	switch code {
	case "output-limit", "invalid-output":
		return model.CollectionInvalidOutput
	case "permission-denied":
		return model.CollectionPermissionDenied
	case "timeout":
		return model.CollectionTimeout
	case "disconnected":
		return model.CollectionDisconnected
	case "utility-unavailable":
		return model.CollectionUnsupported
	default:
		return model.CollectionCommandFailed
	}
}

func intPointerIfKnown(value int) *int {
	if value < 0 {
		return nil
	}

	return &value
}
