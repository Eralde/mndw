package backend

import (
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync"
)

type invariantID string

const (
	invI1  invariantID = "I1"
	invI2  invariantID = "I2"
	invI3  invariantID = "I3"
	invI4  invariantID = "I4"
	invI5  invariantID = "I5"
	invI6  invariantID = "I6"
	invI7  invariantID = "I7"
	invI8  invariantID = "I8"
	invI9  invariantID = "I9"
	invI10 invariantID = "I10"
	invI11 invariantID = "I11"
	invI12 invariantID = "I12"
	invI13 invariantID = "I13"
	invI14 invariantID = "I14"
)

type invariantMode int

const (
	invariantEnforced invariantMode = iota
	invariantObserved
	invariantFixture
)

var invariantModes = map[invariantID]invariantMode{
	invI1:  invariantEnforced,
	invI2:  invariantEnforced,
	invI3:  invariantEnforced,
	invI4:  invariantEnforced,
	invI5:  invariantEnforced,
	invI6:  invariantEnforced,
	invI7:  invariantEnforced,
	invI8:  invariantEnforced,
	invI9:  invariantEnforced,
	invI10: invariantEnforced,
	invI11: invariantEnforced,
	invI12: invariantEnforced,
	invI13: invariantObserved,
	invI14: invariantEnforced,
}

type invariantViolation struct {
	ID       invariantID
	PluginID string
	Detail   string
}

type invariantRecord struct {
	invariantViolation
	Site string
	Mode invariantMode
}

type invariantFixtureDeclaration struct {
	PluginID string
	ID       invariantID
	Reason   string
}

type invariantRecordKey struct {
	ID       invariantID
	PluginID string
	Site     string
	Mode     invariantMode
}

type invariantSupervisorRegistry struct {
	mu          sync.Mutex
	supervisors []*Supervisor
}

var invariantChecksEnabled bool

var invariantRegistry invariantSupervisorRegistry

const invariantRecordLimit = 100

func captureInvariantCreationSite() (string, string) {
	programCounters := make([]uintptr, 32)
	count := runtime.Callers(2, programCounters)
	frames := runtime.CallersFrames(programCounters[:count])

	for frame, more := frames.Next(); more; frame, more = frames.Next() {
		function := frame.Function

		if closure := strings.Index(function, ".func"); closure >= 0 {
			function = function[:closure]
		}

		createdBy := function

		if separator := strings.LastIndex(function, "."); separator >= 0 {
			function = function[separator+1:]
		}

		if strings.HasPrefix(function, "Test") {
			return fmt.Sprintf("%s:%d", frame.File, frame.Line), createdBy
		}
	}

	return "", ""
}

func registerInvariantSupervisor(s *Supervisor) {
	s.invariantCreatedAt, s.invariantCreatedBy = captureInvariantCreationSite()

	invariantRegistry.mu.Lock()

	invariantRegistry.supervisors = append(invariantRegistry.supervisors, s)

	invariantRegistry.mu.Unlock()
}

func (s *Supervisor) unlock() {
	if invariantChecksEnabled && !s.invariantChecksOff {
		s.recordInvariantViolationsLocked(invariantUnlockSite())
	}

	s.mu.Unlock()
}

func (s *Supervisor) recordInvariantViolationsLocked(site string) {
	violations := s.checkInvariantsLocked()
	current := make(map[*pluginRecord]map[invariantID]struct{})

	for _, violation := range violations {
		if record := s.plugins[violation.PluginID]; record != nil {
			if current[record] == nil {
				current[record] = make(map[invariantID]struct{})
			}

			current[record][violation.ID] = struct{}{}
		}
	}

	for record, exemptIDs := range s.invariantFixtureExempt {
		currentIDs := current[record]

		for id := range exemptIDs {
			if _, stillViolated := currentIDs[id]; !stillViolated {
				delete(exemptIDs, id)
			}
		}

		if len(exemptIDs) == 0 {
			delete(s.invariantFixtureExempt, record)
		}
	}

	if len(violations) == 0 {
		return
	}

	if s.invariantSeen == nil {
		s.invariantSeen = make(map[invariantRecordKey]struct{})
	}

	modeCounts := make(map[invariantMode]int)

	for _, record := range s.invariantRecords {
		modeCounts[record.Mode]++
	}

	for _, violation := range violations {
		mode := invariantModes[violation.ID]

		if _, declared := s.invariantDeclaredFixtureExempt[violation.PluginID][violation.ID]; declared {
			mode = invariantFixture
		} else if record := s.plugins[violation.PluginID]; record != nil {
			if _, fixture := s.invariantFixtureExempt[record][violation.ID]; fixture {
				mode = invariantFixture
			}
		}

		key := invariantRecordKey{ID: violation.ID, PluginID: violation.PluginID, Site: site, Mode: mode}

		if _, seen := s.invariantSeen[key]; seen {
			continue
		}

		s.invariantSeen[key] = struct{}{}

		if mode != invariantEnforced && modeCounts[mode] >= invariantRecordLimit {
			if s.invariantDropped == nil {
				s.invariantDropped = make(map[invariantMode]int)
			}

			s.invariantDropped[mode]++

			continue
		}

		s.invariantRecords = append(s.invariantRecords, invariantRecord{
			invariantViolation: violation,
			Site:               site,
			Mode:               mode,
		})
		modeCounts[mode]++
	}
}

func invariantUnlockSite() string {
	programCounter, _, _, ok := runtime.Caller(2)

	if !ok {
		return "unknown"
	}

	function := runtime.FuncForPC(programCounter)

	if function == nil {
		return "unknown"
	}

	return function.Name()
}

// checkInvariantsLocked checks supervisor state while the caller holds s.mu.
// It only inspects in-memory state and does not call hooks or wait on other work.
func (s *Supervisor) checkInvariantsLocked() []invariantViolation {
	var violations []invariantViolation

	if violation, ok := checkInvariantI7(s); ok {
		violations = append(violations, violation)
	}

	checkI13 := !s.shuttingDown && (s.lifetimeCtx == nil || s.lifetimeCtx.Err() == nil) &&
		s.reservedServices < s.cfg.Limits.MaxSupervisedServices

	for pluginID, record := range s.plugins {
		if record == nil {
			continue
		}

		if violation, ok := checkInvariantI1(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI2(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI3(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI4(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI5(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI6(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI8(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI9(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI10(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI11(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if violation, ok := checkInvariantI12(pluginID, record); ok {
			violations = append(violations, violation)
		}

		if checkI13 {
			if violation, ok := checkInvariantI13(pluginID, record, s.reservedServices, s.cfg.Limits.MaxSupervisedServices); ok {
				violations = append(violations, violation)
			}
		}

		if violation, ok := checkInvariantI14(pluginID, record); ok {
			violations = append(violations, violation)
		}
	}

	if len(violations) > 1 {
		slices.SortStableFunc(violations, func(left, right invariantViolation) int {
			return strings.Compare(left.PluginID, right.PluginID)
		})
	}

	return violations
}

func checkInvariantI1(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if record.launch == nil || record.process == nil {
		return invariantViolation{}, false
	}

	return invariantViolation{ID: invI1, PluginID: pluginID, Detail: "launch=true process=true"}, true
}

func checkInvariantI2(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if (record.launch == nil && record.process == nil) || record.serviceHeld {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI2,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("launch=%t process=%t serviceHeld=%t", record.launch != nil, record.process != nil, record.serviceHeld),
	}, true
}

func checkInvariantI3(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if !record.reservationPending || (record.serviceHeld && record.launch == nil && record.process == nil) {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI3,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"reservationPending=%t serviceHeld=%t launch=%t process=%t",
			record.reservationPending,
			record.serviceHeld,
			record.launch != nil,
			record.process != nil,
		),
	}, true
}

func checkInvariantI4(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	stopDone := record.stopDone != nil

	if record.stopping == stopDone && (!record.releaseOnStop || record.stopping) {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI4,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"stopping=%t stopDone=%t releaseOnStop=%t",
			record.stopping,
			stopDone,
			record.releaseOnStop,
		),
	}, true
}

func checkInvariantI5(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if !record.processRegistered || record.process != nil {
		return invariantViolation{}, false
	}

	return invariantViolation{ID: invI5, PluginID: pluginID, Detail: "processRegistered=true process=false"}, true
}

func checkInvariantI6(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	emptyPendingSpec := record.pendingStartSpec.Equal(ServiceSpec{})

	if record.pendingStart || (!record.pendingStartRetry && emptyPendingSpec) {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI6,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"pendingStart=%t pendingStartRetry=%t pendingStartSpecEmpty=%t",
			record.pendingStart,
			record.pendingStartRetry,
			emptyPendingSpec,
		),
	}, true
}

func checkInvariantI7(s *Supervisor) (invariantViolation, bool) {
	serviceHeld := 0

	for _, record := range s.plugins {
		if record != nil && record.serviceHeld {
			serviceHeld++
		}
	}

	if s.reservedServices == serviceHeld {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:     invI7,
		Detail: fmt.Sprintf("reservedServices=%d serviceHeldRecords=%d", s.reservedServices, serviceHeld),
	}, true
}

func checkInvariantI8(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if record.servicePresent || (record.launch == nil && record.process == nil && record.retryTimer == nil &&
		!record.stopping && !record.serviceHeld && !record.pendingStart && !record.startupQueued) {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI8,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"servicePresent=%t launch=%t process=%t retryTimer=%t stopping=%t serviceHeld=%t pendingStart=%t startupQueued=%t",
			record.servicePresent,
			record.launch != nil,
			record.process != nil,
			record.retryTimer != nil,
			record.stopping,
			record.serviceHeld,
			record.pendingStart,
			record.startupQueued,
		),
	}, true
}

func checkInvariantI9(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if !record.transitionPresent {
		return invariantViolation{}, false
	}

	runCompleted := record.run != nil && record.run.completed
	runActive := record.run != nil && !record.run.completed

	if (record.operation != OpNone) == runActive {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI9,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("transitionPresent=true operation=%d runActive=%t runCompleted=%t", record.operation, runActive, runCompleted),
	}, true
}

func checkInvariantI10(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if record.status.State != StateReady || (record.process != nil && record.processRegistered) {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI10,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("status.State=%q process=%t processRegistered=%t", record.status.State, record.process != nil, record.processRegistered),
	}, true
}

func checkInvariantI11(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if record.retryTimer == nil || (record.desired != nil && record.desired.Enabled) {
		return invariantViolation{}, false
	}

	desiredEnabled := record.desired != nil && record.desired.Enabled

	return invariantViolation{
		ID:       invI11,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("retryTimer=true desiredPresent=%t desiredEnabled=%t", record.desired != nil, desiredEnabled),
	}, true
}

func checkInvariantI12(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if !record.stopping || record.launch == nil {
		return invariantViolation{}, false
	}

	return invariantViolation{ID: invI12, PluginID: pluginID, Detail: "stopping=true launch=true"}, true
}

func checkInvariantI13(pluginID string, record *pluginRecord, reservedServices int, maxServices int) (invariantViolation, bool) {
	// promoteBlocked copies desired at supervisor.go:2336-2342, then compares desired with that copy at :2365-2368,
	// so serviceSpec is not part of admissibility. reserveForReconcileLocked rejects stopping at :1204.
	if record.status.State != StateCapacityBlocked || !record.servicePresent || record.desired == nil ||
		!record.desired.Enabled || record.serviceHeld || record.stopping || !record.transitionPresent ||
		record.operation != OpNone || record.intent != IntentRun {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI13,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"reservedServices=%d maxSupervisedServices=%d status.State=%q servicePresent=%t desired.Enabled=%t serviceHeld=%t stopping=%t transitionPresent=%t operation=%d intent=%d",
			reservedServices,
			maxServices,
			record.status.State,
			record.servicePresent,
			record.desired.Enabled,
			record.serviceHeld,
			record.stopping,
			record.transitionPresent,
			record.operation,
			record.intent,
		),
	}, true
}

func checkInvariantI14(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if !record.serviceHeld || record.reservationPending || record.launch != nil || record.process != nil ||
		record.stopping || record.pendingStart || record.startupQueued || record.status.State == StateBackoff ||
		record.status.State == StateFailed ||
		(record.transitionPresent && record.run != nil && !record.run.completed) {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI14,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"serviceHeld=%t reservationPending=%t launch=%t process=%t stopping=%t pendingStart=%t startupQueued=%t status.State=%q activeRun=%t",
			record.serviceHeld,
			record.reservationPending,
			record.launch != nil,
			record.process != nil,
			record.stopping,
			record.pendingStart,
			record.startupQueued,
			record.status.State,
			record.transitionPresent && record.run != nil && !record.run.completed,
		),
	}, true
}
