package persistent

import (
	"sort"
	"sync"
	"time"
)

type diagnosticsRecorder struct {
	mu      *sync.Mutex
	now     Clock
	global  Diagnostics
	targets map[string]TargetDiagnostics
}

func newDiagnosticsRecorder(mu *sync.Mutex, now Clock, base Diagnostics) *diagnosticsRecorder {
	return &diagnosticsRecorder{mu: mu, now: now, global: base, targets: make(map[string]TargetDiagnostics)}
}

func (d *diagnosticsRecorder) snapshotLocked() Diagnostics {
	diagnostics := cloneDiagnostics(d.global)
	diagnostics.Targets = make([]TargetDiagnostics, 0, len(d.targets))

	for _, target := range d.targets {
		diagnostics.Targets = append(diagnostics.Targets, cloneTargetDiagnostics(target))
	}

	sort.Slice(diagnostics.Targets, func(i, j int) bool {
		return diagnostics.Targets[i].Identity < diagnostics.Targets[j].Identity
	})

	return diagnostics
}

func (d *diagnosticsRecorder) recordConnectionAttemptLocked() {
	d.global.ConnectionAttempts++
}

func (d *diagnosticsRecorder) recordConnectedLocked() {
	now := d.now()

	if d.global.LastConnectedAt != nil {
		d.global.ReconnectCount++
	}

	d.global.Connected = true
	d.global.LastConnectedAt = timePointer(now)
}

func (d *diagnosticsRecorder) recordDisconnectedLocked(reason string) {
	now := d.now()

	d.global.Connected = false
	d.global.LastDisconnectedAt = timePointer(now)
	d.global.LastDisconnectReason = reason
}

func (d *diagnosticsRecorder) recordTargetsLocked(targetCount, sessionCount int) {
	now := d.now()

	d.global.TargetCount = targetCount
	d.global.TargetEnumerations++
	d.global.SessionCount = sessionCount
	d.global.LastTargetsAt = timePointer(now)
}

func (d *diagnosticsRecorder) recordSessionCountLocked(sessionCount int) {
	d.global.SessionCount = sessionCount
}

func (d *diagnosticsRecorder) setCountsLocked(targetCount, sessionCount int) {
	d.global.TargetCount = targetCount
	d.global.SessionCount = sessionCount
}

func (d *diagnosticsRecorder) recordTelemetrySuccessLocked() {
	d.global.LastTelemetryAt = timePointer(d.now())
}

func (d *diagnosticsRecorder) recordTargetTelemetrySuccessLocked(identity string) {
	diagnostic := d.targets[identity]
	diagnostic.LastTelemetryAt = timePointer(d.now())
	diagnostic.LastTelemetryError = nil
	d.targets[identity] = diagnostic
}

func (d *diagnosticsRecorder) recordTargetTelemetryErrorLocked(identity string, diagnostic DiagnosticError) {
	diagnostic.At = d.now()
	targetDiagnostic := d.targets[identity]
	targetDiagnostic.LastTelemetryError = cloneDiagnosticError(&diagnostic)
	d.targets[identity] = targetDiagnostic
}

func (d *diagnosticsRecorder) recordTargetErrorLocked(identity string, status int, err error) {
	diagnostic := persistentDiagnosticError(identity, status, err, d.now(), targetDiagnosticMessages)

	d.recordErrorLocked(*diagnostic)
}

func (d *diagnosticsRecorder) recordErrorLocked(diagnostic DiagnosticError) {
	diagnostic.At = d.now()
	d.global.LastError = &diagnostic
}

func (d *diagnosticsRecorder) recordTelemetryPhaseLocked(identity, phase string, status int, err error) {
	now := d.now()
	diagnostic := d.targets[identity]

	if diagnostic.Identity == "" {
		diagnostic.Identity = identity
		diagnostic.FirstSeenAt = timePointer(now)
		diagnostic.Present = true
		diagnostic.SessionPresent = true
	}

	phaseDiagnostic := telemetryPhase(&diagnostic.Telemetry, phase)

	if phaseDiagnostic == nil {
		return
	}

	phaseDiagnostic.LastAttemptAt = timePointer(now)

	if err == nil && status == 200 {
		phaseDiagnostic.LastSuccessAt = timePointer(now)
	} else {
		phaseDiagnostic.LastError = persistentDiagnosticError(
			identity,
			status,
			err,
			now,
			newTelemetryDiagnosticMessages(phase),
		)
	}

	d.targets[identity] = diagnostic
}

func (d *diagnosticsRecorder) recordTargetChangeLocked(reason string, added, removed []string, at time.Time) {
	sort.Strings(added)
	sort.Strings(removed)

	d.global.LastTargetChange = &TargetChange{
		At: at, Reason: reason, Added: append([]string(nil), added...), Removed: append([]string(nil), removed...),
	}
}

func (d *diagnosticsRecorder) markTargetGoneLocked(identity, reason string, now time.Time) {
	diagnostic := d.targets[identity]
	diagnostic.Present = false
	diagnostic.SessionPresent = false
	diagnostic.Live = false
	diagnostic.SessionReason = reason
	diagnostic.LastSessionChangeAt = timePointer(now)
	diagnostic.RemovedAt = timePointer(now)
	d.targets[identity] = diagnostic
}

func (d *diagnosticsRecorder) pruneLocked() {
	removed := make([]TargetDiagnostics, 0, len(d.targets))

	for _, diagnostic := range d.targets {
		if !diagnostic.Present {
			removed = append(removed, diagnostic)
		}
	}

	if len(removed) <= maxRecentTargetDiagnostics {
		return
	}

	sort.Slice(removed, func(i, j int) bool {
		return diagnosticTime(removed[i].RemovedAt).Before(diagnosticTime(removed[j].RemovedAt))
	})

	for _, diagnostic := range removed[:len(removed)-maxRecentTargetDiagnostics] {
		delete(d.targets, diagnostic.Identity)
	}
}
