package backend

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

type expectedInvariantViolation struct {
	id       string
	pluginID string
}

func TestMain(m *testing.M) {
	status := m.Run()

	invariantRegistry.mu.Lock()

	supervisors := append([]*Supervisor(nil), invariantRegistry.supervisors...)

	invariantRegistry.mu.Unlock()

	type summaryKey struct {
		id   invariantID
		mode invariantMode
	}

	type supervisorSnapshot struct {
		createdAt string
		createdBy string
		records   []invariantRecord
		dropped   map[invariantMode]int
		declared  []invariantFixtureDeclaration
	}

	var snapshots []supervisorSnapshot
	unreadable := 0

	for _, supervisor := range supervisors {
		if !supervisor.mu.TryLock() {
			unreadable++

			fmt.Fprintf(os.Stderr, "invariant audit: supervisor created at %s by %s is locked\n", supervisor.invariantCreatedAt, supervisor.invariantCreatedBy)

			continue
		}

		snapshot := supervisorSnapshot{
			createdAt: supervisor.invariantCreatedAt,
			createdBy: supervisor.invariantCreatedBy,
			records:   append([]invariantRecord(nil), supervisor.invariantRecords...),
			dropped:   make(map[invariantMode]int, len(supervisor.invariantDropped)),
		}

		for pluginID, declaredIDs := range supervisor.invariantDeclaredFixtureExempt {
			for id, reason := range declaredIDs {
				snapshot.declared = append(snapshot.declared, invariantFixtureDeclaration{
					PluginID: pluginID,
					ID:       id,
					Reason:   reason,
				})
			}
		}

		for mode, count := range supervisor.invariantDropped {
			snapshot.dropped[mode] = count
		}

		supervisor.mu.Unlock()

		snapshots = append(snapshots, snapshot)
	}

	counts := make(map[summaryKey]int)
	sitesByID := make(map[invariantID]map[string]struct{})
	testsByID := make(map[invariantID]map[string]struct{})
	dropped := make(map[invariantMode]int)
	enforced := false

	for _, snapshot := range snapshots {
		for mode, count := range snapshot.dropped {
			dropped[mode] += count
		}

		for _, record := range snapshot.records {
			counts[summaryKey{id: record.ID, mode: record.Mode}]++

			if sitesByID[record.ID] == nil {
				sitesByID[record.ID] = make(map[string]struct{})
			}

			sitesByID[record.ID][record.Site] = struct{}{}

			if testsByID[record.ID] == nil {
				testsByID[record.ID] = make(map[string]struct{})
			}

			testsByID[record.ID][snapshot.createdBy] = struct{}{}

			if record.Mode == invariantEnforced {
				enforced = true

				fmt.Fprintf(os.Stderr,
					"invariant violation: %s plugin=%s site=%s created-at=%s created-by=%s detail=%s\n",
					record.ID, record.PluginID, record.Site, snapshot.createdAt, snapshot.createdBy, record.Detail)
			}
		}
	}

	if os.Getenv("BACKEND_INVARIANT_REPORT") == "1" {
		keys := make([]summaryKey, 0, len(counts))

		for key := range counts {
			keys = append(keys, key)
		}

		sort.Slice(keys, func(i int, j int) bool {
			if keys[i].id != keys[j].id {
				return keys[i].id < keys[j].id
			}

			return keys[i].mode < keys[j].mode
		})

		for _, key := range keys {
			fmt.Fprintf(os.Stderr, "invariant summary: mode=%s id=%s count=%d\n", invariantModeName(key.mode), key.id, counts[key])
		}

		for _, snapshot := range snapshots {
			sort.Slice(snapshot.declared, func(i int, j int) bool {
				if snapshot.declared[i].PluginID != snapshot.declared[j].PluginID {
					return snapshot.declared[i].PluginID < snapshot.declared[j].PluginID
				}

				return snapshot.declared[i].ID < snapshot.declared[j].ID
			})

			for _, declared := range snapshot.declared {
				fmt.Fprintf(os.Stderr, "invariant declared fixture: plugin=%s id=%s reason=%q created-at=%s created-by=%s\n",
					declared.PluginID, declared.ID, declared.Reason, snapshot.createdAt, snapshot.createdBy)
			}
		}

		ids := make([]string, 0, len(sitesByID))

		for id := range sitesByID {
			ids = append(ids, string(id))
		}

		sort.Strings(ids)

		for _, value := range ids {
			id := invariantID(value)

			fmt.Fprintf(os.Stderr, "invariant detail: id=%s distinct-sites=%d distinct-tests=%d\n", id, len(sitesByID[id]), len(testsByID[id]))

		}

		for _, mode := range []invariantMode{invariantObserved, invariantFixture} {
			if dropped[mode] > 0 {
				fmt.Fprintf(os.Stderr, "invariant dropped: mode=%s count=%d\n", invariantModeName(mode), dropped[mode])
			}
		}

		fmt.Fprintf(os.Stderr, "invariant unreadable supervisors: %d\n", unreadable)
	}

	if enforced {
		status = 1
	}

	os.Exit(status)
}

func invariantModeName(mode invariantMode) string {
	switch mode {
	case invariantEnforced:
		return "enforced"
	case invariantObserved:
		return "observed"
	case invariantFixture:
		return "fixture"
	default:
		return "unknown"
	}
}

func TestCheckInvariantsDetectsEachViolation(t *testing.T) {
	tests := []struct {
		name           string
		wantID         string
		wantPlugin     string
		cancelLifetime bool
		configure      func(*Supervisor, *pluginRecord)
	}{
		{
			name: "clean",
		},
		{
			name:       "I2 process state requires a held slot",
			wantID:     "I2",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.service.proc = procLaunching{launch: &launchIdentity{}}
			},
		},
		{
			name:       "I2 process without a held slot",
			wantID:     "I2",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.service.proc = procStarted{process: &registeredProcess{}}
			},
		},
		{
			name:       "I3 pending reservation has a launch",
			wantID:     "I3",
			wantPlugin: "demo",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotReservedByReconcile
				record.service.proc = procLaunching{launch: &launchIdentity{}}
				s.reservedServices = 1
			},
		},
		{
			name:       "I3 pending reservation has a process",
			wantID:     "I3",
			wantPlugin: "demo",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotReservedByReconcile
				record.service.proc = procStarted{process: &registeredProcess{}}
				s.reservedServices = 1
			},
		},
		{
			name:       "I4 stop state requires done channel",
			wantID:     "I4",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.service.stop = &stopState{}
			},
		},
		{
			name: "I4 stop state with done channel is valid",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.service.stop = &stopState{done: make(chan struct{}), kind: stopRelease}
			},
		},
		{
			name:   "I7 reserved service count matches records",
			wantID: "I7",
			configure: func(s *Supervisor, _ *pluginRecord) {
				s.reservedServices = 1
			},
		},
		{
			name:       "I9 active operation has an incomplete run",
			wantID:     "I9",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.transition = &transitionState{}
				record.transition.operation = OpStarting
			},
		},
		{
			name:       "I9 incomplete run requires an active operation",
			wantID:     "I9",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.transition = &transitionState{}
				record.transition.run = &operationRun{}
			},
		},
		{
			name:       "I9 active operation requires an incomplete run",
			wantID:     "I9",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.transition = &transitionState{}
				record.transition.operation = OpStarting
				record.transition.run = &operationRun{completed: true}
			},
		},
		{
			name:       "I10 ready service has a registered process",
			wantID:     "I10",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.service.status.State = StateReady
			},
		},
		{
			name:       "I10 ready process must be registered",
			wantID:     "I10",
			wantPlugin: "demo",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.status.State = StateReady
				record.service.proc = procStarted{process: &registeredProcess{}}
				record.service.slot = slotHeld
				s.reservedServices = 1
			},
		},
		{
			name:       "I11 retry timer has enabled desired service",
			wantID:     "I11",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				record.service.retry = &retryState{timer: time.NewTimer(time.Hour)}
			},
		},
		{
			name:       "I11 retry timer requires enabled desired service",
			wantID:     "I11",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				desired := ServiceSpec{PluginID: "demo", Enabled: false}
				record.desired = &desired
				record.service.retry = &retryState{timer: time.NewTimer(time.Hour)}
			},
		},
		{
			name:       "I12 stop record has no launch",
			wantID:     "I12",
			wantPlugin: "demo",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.stop = &stopState{done: make(chan struct{})}
				record.service.proc = procLaunching{launch: &launchIdentity{}}
				record.service.slot = slotHeld
				s.reservedServices = 1
			},
		},
		{
			name:       "I13 admissible plugin is not capacity blocked",
			wantID:     "I13",
			wantPlugin: "demo",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.service.spec = ServiceSpec{PluginID: "demo", Enabled: false}
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.status.State = StateCapacityBlocked
			},
		},
		{
			name: "I13 skips disabled desired service",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: false}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.status.State = StateCapacityBlocked
			},
		},
		{
			name: "I13 skips absent transition",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.service.status.State = StateCapacityBlocked
			},
		},
		{
			name: "I13 skips active operation",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.transition.operation = OpStarting
				record.transition.run = &operationRun{}
				record.service.status.State = StateCapacityBlocked
			},
		},
		{
			name: "I13 skips pending start with held slot",
			configure: func(s *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.slot = slotHeld
				record.service.pending = &startRequest{}
				record.service.status.State = StateCapacityBlocked
				s.reservedServices = 1
			},
		},
		{
			name: "I13 skipped at capacity",
			configure: func(s *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.status.State = StateCapacityBlocked
				s.reservedServices = s.cfg.Limits.MaxSupervisedServices

				for index := 0; index < s.reservedServices; index++ {
					pluginID := fmt.Sprintf("slot-%d", index)
					s.plugins[pluginID] = &pluginRecord{
						service: &serviceState{pending: &startRequest{}, slot: slotHeld},
					}
				}
			},
		},
		{
			name:           "I13 skipped with canceled lifetime context",
			cancelLifetime: true,
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.status.State = StateCapacityBlocked
			},
		},
		{
			name: "I13 skips records with a non-run intent",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentStop
				record.service.status.State = StateCapacityBlocked
			},
		},
		{
			name: "I13 skips stop records",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.status.State = StateCapacityBlocked
				record.service.stop = &stopState{done: make(chan struct{})}
			},
		},
		{
			name: "I13 skips records for absent services",
			configure: func(_ *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				// The absent service's zero status already skips this I13 candidate.
				record.service = nil
			},
		},
		{
			name: "I13 skipped during shutdown",
			configure: func(s *Supervisor, record *pluginRecord) {
				spec := ServiceSpec{PluginID: "demo", Enabled: true}
				record.desired = &spec
				record.service.spec = spec
				record.transition = &transitionState{}
				record.transition.intent = IntentRun
				record.service.status.State = StateCapacityBlocked
				s.shuttingDown = true
			},
		},
		{
			name:       "I14 held slot has an owner or pending state",
			wantID:     "I14",
			wantPlugin: "demo",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				s.reservedServices = 1
			},
		},
		{
			name: "I14 held slot can be stopping",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				record.service.stop = &stopState{done: make(chan struct{})}
				s.reservedServices = 1
			},
		},
		{
			name: "I14 held slot can have a pending start",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				record.service.pending = &startRequest{}
				s.reservedServices = 1
			},
		},
		{
			name: "I14 held slot can have a queued startup",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				record.service.startup = &startupTicket{spec: record.service.spec}
				s.reservedServices = 1
			},
		},
		{
			name: "I14 held slot can be in backoff",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				record.service.status.State = StateBackoff
				s.reservedServices = 1
			},
		},
		{
			name:       "I14 held slot of a failed plugin is an orphan",
			wantID:     "I14",
			wantPlugin: "demo",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				record.service.status.State = StateFailed
				s.reservedServices = 1
			},
		},
		{
			name: "I14 held slot can belong to an active run",
			configure: func(s *Supervisor, record *pluginRecord) {
				record.service.slot = slotHeld
				record.transition = &transitionState{}
				record.transition.operation = OpStarting
				record.transition.run = &operationRun{}
				s.reservedServices = 1
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := testSupervisorConfig(t)
			var cancelLifetime context.CancelFunc

			if test.cancelLifetime {
				config.LifetimeCtx, cancelLifetime = context.WithCancel(context.Background())

				t.Cleanup(cancelLifetime)
			}

			s := newSupervisor(config, NewAdmission(Limits{MaxSupervisedServices: 2}))
			s.invariantChecksOff = true
			s.startDesired = func(ServiceSpec) {}

			spec := ServiceSpec{PluginID: "demo", Enabled: true}
			record := &pluginRecord{service: &serviceState{spec: spec}}

			s.mu.Lock()

			s.plugins["demo"] = record

			if test.configure != nil {
				test.configure(s, record)
			}

			if cancelLifetime != nil {
				cancelLifetime()
			}

			got := s.checkInvariantsLocked()

			s.mu.Unlock()

			if record.service != nil && record.service.retry != nil && record.service.retry.timer != nil {
				t.Cleanup(func() { record.service.retry.timer.Stop() })
			}

			if test.wantID == "" {
				if len(got) != 0 {
					t.Fatalf("checkInvariantsLocked() = %#v, want no violations", got)
				}

				return
			}

			if len(got) != 1 {
				t.Fatalf("checkInvariantsLocked() = %#v, want exactly one violation", got)
			}

			if string(got[0].ID) != test.wantID {
				t.Errorf("violation ID = %q, want %q", got[0].ID, test.wantID)
			}

			if got[0].PluginID != test.wantPlugin {
				t.Errorf("violation plugin ID = %q, want %q", got[0].PluginID, test.wantPlugin)
			}

		})
	}
}

func TestCheckInvariantsSortsByPluginAndPreservesInvariantOrder(t *testing.T) {
	s := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))
	s.invariantChecksOff = true
	s.startDesired = func(ServiceSpec) {}

	demo := &pluginRecord{
		service: &serviceState{
			spec: ServiceSpec{PluginID: "demo", Enabled: true},
			proc: procStarted{process: &registeredProcess{}},
		},
	}
	alpha := &pluginRecord{
		transition: &transitionState{operation: OpStarting},
	}

	s.mu.Lock()

	s.plugins["demo"] = demo
	s.plugins["alpha"] = alpha
	demo.service.status.State = StateReady
	got := s.checkInvariantsLocked()

	s.mu.Unlock()

	want := []expectedInvariantViolation{
		{id: "I9", pluginID: "alpha"},
		{id: "I2", pluginID: "demo"},
		{id: "I10", pluginID: "demo"},
	}

	if len(got) != len(want) {
		t.Fatalf("checkInvariantsLocked() = %#v, want %#v", got, want)
	}

	for index, expected := range want {
		if string(got[index].ID) != expected.id || got[index].PluginID != expected.pluginID {
			t.Errorf("violation[%d] = (%q, %q), want (%q, %q)", index, got[index].ID, got[index].PluginID, expected.id, expected.pluginID)
		}
	}
}

func TestNoRawSupervisorUnlocks(t *testing.T) {
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read backend package: %v", err)
	}

	unlockPattern := regexp.MustCompile(`([[:alnum:]_.]+)\.mu\.Unlock\(\)`)
	allowedOtherMutexes := map[string]string{
		"a":                 "limits.go",
		"r.admission":       "limits.go",
		"invariantRegistry": "invariants.go",
		"r":                 "stderr_ring.go",
	}
	supervisorUnlocks := 0

	for _, file := range files {
		name := file.Name()

		if file.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}

		contents, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}

		for _, match := range unlockPattern.FindAllStringSubmatch(string(contents), -1) {
			receiver := match[1]

			if allowedFile, allowed := allowedOtherMutexes[receiver]; allowed && allowedFile == name {
				continue
			}

			if name == "invariants.go" && receiver == "s" {
				supervisorUnlocks++

				continue
			}

			t.Errorf("%s contains raw %s.mu.Unlock() outside an allowlisted mutex", name, receiver)
		}
	}

	if supervisorUnlocks != 1 {
		t.Errorf("invariants.go contains %d raw supervisor unlocks, want one inside unlock()", supervisorUnlocks)
	}
}

func TestPresencePointersNeverReset(t *testing.T) {
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read backend package: %v", err)
	}

	var violations []string

	for _, file := range files {
		name := file.Name()

		if file.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}

		contents, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}

		for _, violation := range presencePointerAssignmentViolations(string(contents)) {
			violations = append(violations, name+":"+violation)
		}
	}

	if len(violations) > 0 {
		t.Errorf("presence pointer assignments violate allocation rules: %s", strings.Join(violations, ", "))
	}

	for _, source := range []string{
		"func reset(record *pluginRecord) { record.service = nil }",
		"func replace(record *pluginRecord) { record.transition = &transitionState{} }",
		"func replace(record *pluginRecord) { record.service = &serviceState{} }",
		"func replace(record *pluginRecord) { *record.service = serviceState{} }",
		"func replace(record *pluginRecord) { *record.transition = transitionState{} }",
		"func reset(record *pluginRecord) { record.transition, record.service.lastStopErr = nil, nil }",
		"func (s *Supervisor) ensureServiceRecordLocked(id string) { record.service = &serviceState{} }",
		"func (s *Supervisor) ensureTransitionRecordLocked(id string) { record.transition = &transitionState{} }",
	} {
		if got := presencePointerAssignmentViolations(source); len(got) != 1 {
			t.Errorf("presence pointer matcher did not reject %q: got %v", source, got)
		}
	}

	allowed := "func (s *Supervisor) ensureServiceRecordLocked(id string) {\n" +
		"\tif record.service == nil {\n\t\trecord.service = &serviceState{}\n\t}\n}\n" +
		"func (s *Supervisor) ensureTransitionRecordLocked(id string) {\n" +
		"\tif record.transition == nil {\n\t\trecord.transition = &transitionState{}\n\t}\n}"

	if got := presencePointerAssignmentViolations(allowed); len(got) != 0 {
		t.Errorf("presence pointer matcher rejected ensure allocations: %v", got)
	}
}

func presencePointerAssignmentViolations(source string) []string {
	functionPattern := regexp.MustCompile(`^\s*func\s+(?:\([^)]*\)\s*)?([[:alnum:]_]+)\s*\(`)
	nilPattern := regexp.MustCompile(`\b[[:alnum:]_.]+\.(service|transition)\s*=\s*nil\b`)
	indirectPattern := regexp.MustCompile(`\*\s*[[:alnum:]_.]+\.(service|transition)\s*=`)
	fieldPattern := regexp.MustCompile(`\b[[:alnum:]_.]+\.(service|transition)\b`)
	allocationPattern := regexp.MustCompile(`\b([[:alnum:]_.]+)\.(service|transition)\s*=\s*&\s*(serviceState|transitionState)\s*\{`)
	newPattern := regexp.MustCompile(`\b([[:alnum:]_.]+)\.(service|transition)\s*=\s*new\((serviceState|transitionState)\)`)
	nilGuardPattern := regexp.MustCompile(`\bif\b[^{]*?([[:alnum:]_.]+)\.(service|transition)\s*==\s*nil\s*\{`)

	type nilGuard struct {
		receiver  string
		field     string
		bodyDepth int
	}

	lines := strings.Split(source, "\n")
	violations := make([]string, 0)
	functionName := ""
	braceDepth := 0
	guards := make([]nilGuard, 0)

	for lineIndex, line := range lines {
		if match := functionPattern.FindStringSubmatch(line); len(match) == 2 {
			functionName = match[1]
			braceDepth = 0
			guards = guards[:0]
		}

		lineNumber := fmt.Sprintf("%d", lineIndex+1)

		if nilPattern.MatchString(line) {
			violations = append(violations, lineNumber+": pointer reset to nil")
		}

		if indirectPattern.MatchString(line) {
			violations = append(violations, lineNumber+": in-place overwrite of presence pointer")
		}

		if assignment := strings.Index(line, "="); assignment >= 0 && !strings.Contains(line, "==") {
			left := strings.Split(line[:assignment], ",")
			right := strings.Split(line[assignment+1:], ",")

			if len(left) > 1 && len(left) == len(right) {
				for index, target := range left {
					value := strings.TrimSpace(strings.TrimRight(right[index], " };"))

					if fieldPattern.MatchString(target) && value == "nil" {
						violations = append(violations, lineNumber+": pointer reset to nil")

						break
					}
				}
			}
		}

		if match := nilGuardPattern.FindStringSubmatch(line); len(match) == 3 {
			guards = append(guards, nilGuard{receiver: match[1], field: match[2], bodyDepth: braceDepth + 1})
		}

		for _, pattern := range []*regexp.Regexp{allocationPattern, newPattern} {
			match := pattern.FindStringSubmatch(line)

			if len(match) != 4 {
				continue
			}

			receiver := match[1]
			field := match[2]
			stateType := match[3]
			allowedFunction := "ensureServiceRecordLocked"

			if field == "transition" {
				allowedFunction = "ensureTransitionRecordLocked"
			}

			guarded := false

			for _, guard := range guards {
				if guard.receiver == receiver && guard.field == field && guard.bodyDepth <= braceDepth+1 {
					guarded = true

					break
				}
			}

			if functionName != allowedFunction || (field == "service") != (stateType == "serviceState") || !guarded {
				violations = append(violations, lineNumber+": state allocation outside "+allowedFunction)
			}
		}

		braceDepth += strings.Count(line, "{") - strings.Count(line, "}")

		activeGuards := guards[:0]

		for _, guard := range guards {
			if guard.bodyDepth <= braceDepth {
				activeGuards = append(activeGuards, guard)
			}
		}

		guards = activeGuards
	}

	return violations
}

func TestInvariantViolationRecordsSites(t *testing.T) {
	s := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

	t.Cleanup(func() { clearInvariantRecordsForTest(s) })

	breakReservationForTest(s)

	records := invariantRecordsForTest(s)

	if len(records) != 1 {
		t.Fatalf("invariant records = %#v, want one", records)
	}

	if records[0].ID != invI3 || !strings.HasSuffix(records[0].Site, ".breakReservationForTest") {
		t.Errorf("record = %+v, want I3 from breakReservationForTest", records[0])
	}

	if !strings.Contains(s.invariantCreatedAt, "invariants_test.go:") {
		t.Errorf("invariantCreatedAt = %q, want invariants_test.go file and line", s.invariantCreatedAt)
	}

	off := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

	t.Cleanup(func() { clearInvariantRecordsForTest(off) })

	off.invariantChecksOff = true

	breakReservationForTest(off)

	if records := invariantRecordsForTest(off); len(records) != 0 {
		t.Errorf("disabled invariant records = %#v, want none", records)
	}

	fixture := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

	t.Cleanup(func() { clearInvariantRecordsForTest(fixture) })

	setSupervisorServiceRecordForTest(fixture, "demo", &serviceRecord{status: RuntimeStatus{State: StateReady}})

	records = invariantRecordsForTest(fixture)

	if len(records) != 1 || records[0].ID != invI10 || records[0].Mode != invariantFixture {
		t.Fatalf("fixture records = %#v, want one fixture I10", records)
	}

	fixture.mu.Lock()

	reserveStartedProcessLockedForTest(fixture, fixture.plugins["demo"])

	fixture.unlock()

	records = invariantRecordsForTest(fixture)

	if !hasInvariantRecord(records, invI3, invariantEnforced) || !hasInvariantRecord(records, invI10, invariantFixture) {
		t.Fatalf("fixture plus enforced records = %#v, want fixture I10 and enforced I3", records)
	}

	recovered := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

	t.Cleanup(func() { clearInvariantRecordsForTest(recovered) })

	setSupervisorServiceRecordForTest(recovered, "demo", &serviceRecord{status: RuntimeStatus{State: StateReady}})
	recovered.mu.Lock()

	recovered.plugins["demo"].service.status.State = StateStopped

	recovered.unlock()
	recovered.mu.Lock()

	recovered.plugins["demo"].service.status.State = StateReady

	recovered.unlock()

	records = invariantRecordsForTest(recovered)

	if len(records) != 2 || !hasInvariantRecord(records, invI10, invariantFixture) ||
		!hasInvariantRecord(records, invI10, invariantEnforced) {
		t.Fatalf("reintroduced violation records = %#v, want fixture and enforced I10", records)
	}

	declared := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

	t.Cleanup(func() { clearInvariantRecordsForTest(declared) })

	setSupervisorServiceRecordForTest(declared, "demo", &serviceRecord{status: RuntimeStatus{State: StateReady}})
	declareInvariantFixtureForTest(declared, "demo", invI10, "test seed has Ready state without a process")
	clearInvariantRecordsForTest(declared)
	declared.mu.Lock()

	declared.plugins["demo"].service.status.State = StateStopped

	declared.unlock()
	declared.mu.Lock()

	declared.plugins["demo"].service.status.State = StateReady

	reserveStartedProcessLockedForTest(declared, declared.plugins["demo"])

	declared.unlock()

	records = invariantRecordsForTest(declared)

	if len(records) != 2 || !hasInvariantRecord(records, invI10, invariantFixture) ||
		!hasInvariantRecord(records, invI3, invariantEnforced) {
		t.Fatalf("declared fixture records = %#v, want exactly fixture I10 and enforced I3", records)
	}

	if reason := declared.invariantDeclaredFixtureExempt["demo"][invI10]; reason != "test seed has Ready state without a process" {
		t.Errorf("declared fixture reason = %q, want original reason", reason)
	}

}

func TestInvariantCreationSiteCapturesSubtest(t *testing.T) {
	t.Run("nested", func(t *testing.T) {
		s := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

		t.Cleanup(func() { clearInvariantRecordsForTest(s) })

		if !strings.Contains(s.invariantCreatedBy, "TestInvariantCreationSiteCapturesSubtest") {
			t.Errorf("invariantCreatedBy = %q, want parent test name", s.invariantCreatedBy)
		}

		if strings.Contains(s.invariantCreatedBy, ".func") {
			t.Errorf("invariantCreatedBy = %q, want closure suffix removed", s.invariantCreatedBy)
		}

		if !strings.HasPrefix(s.invariantCreatedBy, "mndwd/internal/backend.") {
			t.Errorf("invariantCreatedBy = %q, want package-qualified test name", s.invariantCreatedBy)
		}
	})
}

func TestMarkInvariantFixtureForTestFiltersIDs(t *testing.T) {
	tests := []struct {
		name       string
		ids        []invariantID
		fixtureIDs []invariantID
	}{
		{name: "selected IDs", ids: []invariantID{invI14}, fixtureIDs: []invariantID{invI14}},
		{name: "no IDs marks all", fixtureIDs: []invariantID{invI10, invI14}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 2}))

			t.Cleanup(func() { clearInvariantRecordsForTest(s) })

			s.mu.Lock()

			record := s.ensurePluginRecordLocked("demo")

			s.ensureServiceRecordLocked("demo")

			record.service.slot = slotHeld
			record.service.status.State = StateReady
			s.reservedServices = 1

			markInvariantFixtureForTest(s, "demo", test.ids...)

			s.unlock()

			records := invariantRecordsForTest(s)

			if len(records) != 2 {
				t.Fatalf("records = %#v, want exactly I10 and I14", records)
			}

			for _, id := range []invariantID{invI10, invI14} {
				wantMode := invariantEnforced

				for _, fixtureID := range test.fixtureIDs {
					if id == fixtureID {
						wantMode = invariantFixture
					}
				}

				if !hasInvariantRecord(records, id, wantMode) {
					t.Errorf("records = %#v, want %s in mode %s", records, id, invariantModeName(wantMode))
				}
			}
		})
	}
}

func breakReservationForTest(s *Supervisor) {
	s.mu.Lock()

	reserveStartedProcessLockedForTest(s, s.ensureServiceRecordLocked("demo"))

	s.unlock()
}

// reserveStartedProcessLockedForTest writes an I3 violation: a Reconcile reservation that owns a process. The
// invariant tests that use it check how violations are recorded, not the I3 rule.
func reserveStartedProcessLockedForTest(s *Supervisor, record *pluginRecord) {
	record.service.slot = slotReservedByReconcile
	record.service.proc = procStarted{process: &registeredProcess{}}
	s.reservedServices = 1
}

func invariantRecordsForTest(s *Supervisor) []invariantRecord {
	s.mu.Lock()

	defer s.mu.Unlock()

	return append([]invariantRecord(nil), s.invariantRecords...)
}

func clearInvariantRecordsForTest(s *Supervisor) {
	s.mu.Lock()

	s.invariantRecords = nil
	s.invariantSeen = nil

	s.mu.Unlock()
}

func hasInvariantRecord(records []invariantRecord, id invariantID, mode invariantMode) bool {
	for _, record := range records {
		if record.ID == id && record.Mode == mode {
			return true
		}
	}

	return false
}
