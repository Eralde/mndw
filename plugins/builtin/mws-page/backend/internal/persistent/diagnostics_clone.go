package persistent

import "time"

func cloneDiagnostics(diagnostics Diagnostics) Diagnostics {
	clone := diagnostics
	clone.LastConnectedAt = cloneTime(diagnostics.LastConnectedAt)
	clone.LastDisconnectedAt = cloneTime(diagnostics.LastDisconnectedAt)
	clone.LastTargetsAt = cloneTime(diagnostics.LastTargetsAt)
	clone.LastTelemetryAt = cloneTime(diagnostics.LastTelemetryAt)
	clone.LastError = cloneDiagnosticError(diagnostics.LastError)

	if diagnostics.LastTargetChange != nil {
		change := *diagnostics.LastTargetChange
		change.Added = append([]string(nil), diagnostics.LastTargetChange.Added...)
		change.Removed = append([]string(nil), diagnostics.LastTargetChange.Removed...)
		clone.LastTargetChange = &change
	}

	clone.Targets = nil

	return clone
}

func cloneTargetDiagnostics(diagnostic TargetDiagnostics) TargetDiagnostics {
	clone := diagnostic
	clone.FirstSeenAt = cloneTime(diagnostic.FirstSeenAt)
	clone.LastSeenAt = cloneTime(diagnostic.LastSeenAt)
	clone.RemovedAt = cloneTime(diagnostic.RemovedAt)
	clone.LastProbeAt = cloneTime(diagnostic.LastProbeAt)
	clone.LastProbeStatus = cloneInt(diagnostic.LastProbeStatus)
	clone.LastProbeError = cloneDiagnosticError(diagnostic.LastProbeError)
	clone.LastTelemetryAt = cloneTime(diagnostic.LastTelemetryAt)
	clone.LastTelemetryError = cloneDiagnosticError(diagnostic.LastTelemetryError)
	clone.LastSessionChangeAt = cloneTime(diagnostic.LastSessionChangeAt)
	clone.Telemetry = cloneTelemetryDiagnostics(diagnostic.Telemetry)

	return clone
}

func cloneTelemetryDiagnostics(diagnostics TelemetryDiagnostics) TelemetryDiagnostics {
	return TelemetryDiagnostics{
		System:    cloneTelemetryPhaseDiagnostics(diagnostics.System),
		CPURRD:    cloneTelemetryPhaseDiagnostics(diagnostics.CPURRD),
		MemoryRRD: cloneTelemetryPhaseDiagnostics(diagnostics.MemoryRRD),
	}
}

func cloneTelemetryPhaseDiagnostics(diagnostics TelemetryPhaseDiagnostics) TelemetryPhaseDiagnostics {
	return TelemetryPhaseDiagnostics{
		LastAttemptAt: cloneTime(diagnostics.LastAttemptAt),
		LastSuccessAt: cloneTime(diagnostics.LastSuccessAt),
		LastError:     cloneDiagnosticError(diagnostics.LastError),
	}
}

func cloneDiagnosticError(diagnostic *DiagnosticError) *DiagnosticError {
	if diagnostic == nil {
		return nil
	}

	return valuePointer(*diagnostic)
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}

	return valuePointer(*value)
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}

	return valuePointer(*value)
}

func timePointer(value time.Time) *time.Time {
	return valuePointer(value)
}

func valuePointer[T any](value T) *T {
	return &value
}

func diagnosticTime(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}

	return *value
}
