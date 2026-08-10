package persistent

import (
	"sort"
	"time"

	"mndw.local/shared/ptr"
)

func cloneDiagnostics(diagnostics Diagnostics) Diagnostics {
	clone := diagnostics

	if diagnostics.LastConnectedAt != nil {
		clone.LastConnectedAt = ptr.To(*diagnostics.LastConnectedAt)
	}

	if diagnostics.LastDisconnectedAt != nil {
		clone.LastDisconnectedAt = ptr.To(*diagnostics.LastDisconnectedAt)
	}

	if diagnostics.LastTargetsAt != nil {
		clone.LastTargetsAt = ptr.To(*diagnostics.LastTargetsAt)
	}

	if diagnostics.LastTelemetryAt != nil {
		clone.LastTelemetryAt = ptr.To(*diagnostics.LastTelemetryAt)
	}

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

	if diagnostic.FirstSeenAt != nil {
		clone.FirstSeenAt = ptr.To(*diagnostic.FirstSeenAt)
	}

	if diagnostic.LastSeenAt != nil {
		clone.LastSeenAt = ptr.To(*diagnostic.LastSeenAt)
	}

	if diagnostic.RemovedAt != nil {
		clone.RemovedAt = ptr.To(*diagnostic.RemovedAt)
	}

	if diagnostic.LastProbeAt != nil {
		clone.LastProbeAt = ptr.To(*diagnostic.LastProbeAt)
	}

	clone.LastProbeStatus = cloneInt(diagnostic.LastProbeStatus)
	clone.LastProbeError = cloneDiagnosticError(diagnostic.LastProbeError)

	if diagnostic.LastTelemetryAt != nil {
		clone.LastTelemetryAt = ptr.To(*diagnostic.LastTelemetryAt)
	}

	clone.LastTelemetryError = cloneDiagnosticError(diagnostic.LastTelemetryError)

	if diagnostic.LastSessionChangeAt != nil {
		clone.LastSessionChangeAt = ptr.To(*diagnostic.LastSessionChangeAt)
	}

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
	clone := TelemetryPhaseDiagnostics{LastError: cloneDiagnosticError(diagnostics.LastError)}

	if diagnostics.LastAttemptAt != nil {
		clone.LastAttemptAt = ptr.To(*diagnostics.LastAttemptAt)
	}

	if diagnostics.LastSuccessAt != nil {
		clone.LastSuccessAt = ptr.To(*diagnostics.LastSuccessAt)
	}

	return clone
}

func cloneDiagnosticError(diagnostic *DiagnosticError) *DiagnosticError {
	if diagnostic == nil {
		return nil
	}

	return ptr.To(*diagnostic)
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}

	return ptr.To(*value)
}

func diagnosticTime(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}

	return *value
}

func sortTargetDiagnostics(targets []TargetDiagnostics) {
	sort.Slice(targets, func(i, j int) bool {
		return targets[i].Identity < targets[j].Identity
	})
}
