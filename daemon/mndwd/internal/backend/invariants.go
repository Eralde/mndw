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
	invI1  invariantID = "I1" // type guarantee since step 5
	invI2  invariantID = "I2"
	invI3  invariantID = "I3"
	invI4  invariantID = "I4"
	invI5  invariantID = "I5" // type guarantee since step 5
	invI6  invariantID = "I6" // type guarantee since step 4
	invI7  invariantID = "I7"
	invI8  invariantID = "I8" // type guarantee since step 7
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
	invI2:  invariantEnforced,
	invI3:  invariantEnforced,
	invI4:  invariantEnforced,
	invI7:  invariantEnforced,
	invI9:  invariantEnforced,
	invI10: invariantEnforced,
	invI11: invariantEnforced,
	invI12: invariantEnforced,
	invI13: invariantEnforced,
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

	// The gate mirrors admissionOpenLocked: while admission is closed, I13 says nothing about admitLocked.
	checkI13 := !s.shuttingDown && (s.lifetimeCtx == nil || s.lifetimeCtx.Err() == nil) && s.startDesired != nil &&
		s.reservedServices < s.cfg.Limits.MaxSupervisedServices

	for pluginID, record := range s.plugins {
		if record == nil {
			continue
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

// invariantPhaseName names the process phase for violation details.
func invariantPhaseName(phase procPhase) string {
	switch phase.(type) {
	case procLaunching:
		return "launching"
	case procStarted:
		return "started"
	case procRegistered:
		return "registered"
	default:
		return "none"
	}
}

func checkInvariantI2(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if record.phase() == nil || record.slot() != slotNone {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI2,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("proc=%s slot=%s", invariantPhaseName(record.phase()), record.slot()),
	}, true
}

func checkInvariantI3(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	if record.slot() != slotReservedByReconcile || record.phase() == nil {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI3,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"slot=%s proc=%s",
			record.slot(),
			invariantPhaseName(record.phase()),
		),
	}, true
}

func checkInvariantI4(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	stop := record.service != nil && record.service.stop != nil

	if !stop || record.service.stop.done != nil {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI4,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("stop=%t done=%t", stop, record.service.stop.done != nil),
	}, true
}

func checkInvariantI7(s *Supervisor) (invariantViolation, bool) {
	slotRecords := 0

	for _, record := range s.plugins {
		if record != nil && record.slot() != slotNone {
			slotRecords++
		}
	}

	if s.reservedServices == slotRecords {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:     invI7,
		Detail: fmt.Sprintf("reservedServices=%d slotRecords=%d", s.reservedServices, slotRecords),
	}, true
}

func checkInvariantI9(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	transition := record.transition

	if transition == nil {
		return invariantViolation{}, false
	}

	runCompleted := transition.run != nil && transition.run.completed
	runActive := transition.run != nil && !transition.run.completed

	if (transition.operation != OpNone) == runActive {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI9,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("transition=true operation=%d runActive=%t runCompleted=%t", transition.operation, runActive, runCompleted),
	}, true
}

func checkInvariantI10(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	status := RuntimeStatus{}

	if record.service != nil {
		status = record.service.status
	}

	registered := record.service != nil && record.service.process() != nil && record.service.registered()

	if status.State != StateReady || registered {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI10,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("status.State=%q proc=%s", status.State, invariantPhaseName(record.phase())),
	}, true
}

func checkInvariantI11(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	retry := record.service != nil && record.service.retry != nil

	if !retry || (record.desired != nil && record.desired.Enabled) {
		return invariantViolation{}, false
	}

	desiredEnabled := record.desired != nil && record.desired.Enabled

	return invariantViolation{
		ID:       invI11,
		PluginID: pluginID,
		Detail:   fmt.Sprintf("retry=true desiredPresent=%t desiredEnabled=%t", record.desired != nil, desiredEnabled),
	}, true
}

func checkInvariantI12(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	stop := record.service != nil && record.service.stop != nil

	if !stop || record.service.launching() == nil {
		return invariantViolation{}, false
	}

	return invariantViolation{ID: invI12, PluginID: pluginID, Detail: "stop=true proc=launching"}, true
}

func checkInvariantI13(pluginID string, record *pluginRecord, reservedServices int, maxServices int) (invariantViolation, bool) {
	// admitLocked compares desired with a copy, so service.spec is not part of admissibility.
	// reserveForReconcileLocked rejects records with an active stop state.
	status := RuntimeStatus{}

	if record.service != nil {
		status = record.service.status
	}

	transition := record.transition
	stop := record.service != nil && record.service.stop != nil

	if status.State != StateCapacityBlocked || record.service == nil || record.desired == nil ||
		!record.desired.Enabled || record.slot() != slotNone || stop || transition == nil ||
		transition.operation != OpNone || transition.intent != IntentRun {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI13,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"reservedServices=%d maxSupervisedServices=%d status.State=%q service=%t desired.Enabled=%t slot=%s stop=%t transition=%t operation=%d intent=%d",
			reservedServices,
			maxServices,
			status.State,
			record.service != nil,
			record.desired.Enabled,
			record.slot(),
			stop,
			transition != nil,
			transition.operation,
			transition.intent,
		),
	}, true
}

func checkInvariantI14(pluginID string, record *pluginRecord) (invariantViolation, bool) {
	status := RuntimeStatus{}

	if record.service != nil {
		status = record.service.status
	}

	activeRun := record.transition != nil && record.transition.run != nil && !record.transition.run.completed
	stop := record.service != nil && record.service.stop != nil
	pending := record.pendingRequest() != nil
	startup := record.service != nil && record.service.startup != nil

	if record.slot() != slotHeld || record.phase() != nil ||
		stop || pending || startup || status.State == StateBackoff ||
		status.State == StateFailed || activeRun {
		return invariantViolation{}, false
	}

	return invariantViolation{
		ID:       invI14,
		PluginID: pluginID,
		Detail: fmt.Sprintf(
			"slot=%s proc=%s stop=%t pending=%t startup=%t status.State=%q activeRun=%t",
			record.slot(),
			invariantPhaseName(record.phase()),
			stop,
			pending,
			startup,
			status.State,
			activeRun,
		),
	}, true
}
