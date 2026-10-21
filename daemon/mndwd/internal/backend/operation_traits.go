package backend

import "errors"

type opTraits struct {
	restoreOnFail bool
	exclusive     bool
	joinable      bool
	supersedes    bool
	supersedable  bool
	stopReason    LifecycleReason
}

var errUnknownOperation = errors.New("unknown lifecycle operation")

var operationTraits = map[Operation]opTraits{
	OpStarting:   {restoreOnFail: true, supersedable: true, stopReason: LifecycleReasonReconciled},
	OpStopping:   {exclusive: true, joinable: true, supersedes: true, stopReason: LifecycleReasonDisabled},
	OpRestarting: {restoreOnFail: true, exclusive: true, joinable: true, supersedable: true, stopReason: LifecycleReasonRestarted},
	OpUpdating:   {restoreOnFail: true, exclusive: true, stopReason: LifecycleReasonUpdated},
	OpDeleting:   {exclusive: true, joinable: true, supersedes: true, stopReason: LifecycleReasonRemoved},
	OpInstalling: {restoreOnFail: true, exclusive: true, stopReason: LifecycleReasonReconciled},
}

func traitsOf(op Operation) opTraits {
	return operationTraits[op]
}

func lifecycleStopReason(op Operation, target Intent) LifecycleReason {
	if target == IntentRemove {
		// Removing a plugin always reports Removed, regardless of operation.
		return LifecycleReasonRemoved
	}

	return traitsOf(op).stopReason
}
