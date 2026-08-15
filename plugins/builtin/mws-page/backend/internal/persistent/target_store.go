package persistent

import (
	"errors"
	"sort"
	"sync"
	"time"

	"mndw.local/rcisock"
)

type targetRecord struct {
	target  Target
	session *sessionState
}

type targetStore struct {
	mu        *sync.Mutex
	now       Clock
	diag      *diagnosticsRecorder
	retention time.Duration
	records   map[string]targetRecord
	locks     map[string]chan struct{}
}

func newTargetStore(mu *sync.Mutex, now Clock, diag *diagnosticsRecorder, retention time.Duration) *targetStore {
	return &targetStore{
		mu:        mu,
		now:       now,
		diag:      diag,
		retention: retention,
		records:   make(map[string]targetRecord),
		locks:     make(map[string]chan struct{}),
	}
}

func (s *targetStore) updateTargets(targets []Target) error {
	current := make(map[string]Target, len(targets))

	for _, target := range targets {
		if target.Identity == "" {
			return errors.New("persistent session target has no identity")
		}

		target.MAC = normalizeMAC(target.MAC)

		if target.MAC == "" {
			continue
		}

		current[target.Identity] = target
	}

	now := s.now()

	s.mu.Lock()

	defer s.mu.Unlock()

	var added, removed []string

	for identity := range s.records {
		if _, ok := current[identity]; !ok {
			delete(s.records, identity)
			s.diag.markTargetGoneLocked(identity, "target-removed", now)

			removed = append(removed, identity)
		}
	}

	for identity, target := range current {
		if _, exists := s.locks[identity]; !exists {
			s.locks[identity] = make(chan struct{}, 1)
			s.locks[identity] <- struct{}{}
		}

		diagnostic, known := s.diag.targets[identity]
		wasPresent := known && diagnostic.Present

		if !known {
			diagnostic = TargetDiagnostics{Identity: identity, FirstSeenAt: timePointer(now)}
		}

		diagnostic.Identity = identity
		diagnostic.Name = target.Name
		diagnostic.MAC = target.MAC
		diagnostic.Present = true
		diagnostic.LastSeenAt = timePointer(now)
		diagnostic.RemovedAt = nil

		if !wasPresent {
			added = append(added, identity)
			diagnostic.SessionReason = "target-added"
			diagnostic.LastSessionChangeAt = timePointer(now)
		}

		record, ok := s.records[identity]

		if !ok || record.session == nil {
			record.session = &sessionState{}
			diagnostic.SessionPresent = true
			diagnostic.Live = false
			diagnostic.Misses = 0

			if wasPresent {
				diagnostic.SessionReason = "session-created"
				diagnostic.LastSessionChangeAt = timePointer(now)
			}
		}

		record.target = target
		record.session.lastSeenAt = now
		diagnostic.SessionPresent = true
		diagnostic.Misses = record.session.misses
		diagnostic.Live = record.session.live
		s.records[identity] = record
		diagTarget := diagnostic
		s.diag.targets[identity] = diagTarget
	}

	if len(added) > 0 || len(removed) > 0 {
		s.diag.recordTargetChangeLocked("enumeration", added, removed, now)
	}

	s.diag.pruneLocked()

	return nil
}

func (s *targetStore) applyResult(target Target, response rcisock.ResponseFrame, err error) {
	s.mu.Lock()

	defer s.mu.Unlock()

	record, ok := s.records[target.Identity]

	if !ok || record.session == nil {
		return
	}

	state := record.session
	diagnostic := s.diag.targets[target.Identity]
	now := s.now()
	diagnostic.LastProbeAt = timePointer(now)

	if response.Status != 0 {
		status := response.Status
		diagnostic.LastProbeStatus = &status
	} else {
		diagnostic.LastProbeStatus = nil
	}

	if err == nil && response.Status == 200 {
		state.misses = 0
		state.live = true
		diagnostic.LastProbeError = nil
		diagnostic.SessionPresent = true
		diagnostic.Live = true
		diagnostic.Misses = 0
		diagnostic.SessionReason = "probe-success"
		diagnostic.LastSessionChangeAt = timePointer(now)
		s.diag.targets[target.Identity] = diagnostic

		return
	}

	diagnostic.LastProbeError = persistentDiagnosticError(
		target.Identity,
		response.Status,
		err,
		now,
		targetDiagnosticMessages,
	)
	var remote *rcisock.RemoteError

	if errors.As(err, &remote) && (remote.Code == "no-session-for-target" || remote.Code == "unsupported-firmware" || remote.Code == "not-permitted") {
		record.session = nil
		s.records[target.Identity] = record

		diagnostic.SessionPresent = false
		diagnostic.Live = false
		diagnostic.Misses = 0
		diagnostic.SessionReason = "evicted:" + remote.Code
		diagnostic.LastSessionChangeAt = timePointer(now)
		s.diag.targets[target.Identity] = diagnostic

		return
	}

	if errors.As(err, &remote) && remote.Code != "session-invalid" && remote.Code != "target-unreachable" {
		s.diag.targets[target.Identity] = diagnostic

		return
	}

	state.misses++

	if state.misses >= 2 {
		state.live = false
	}

	diagnostic.SessionPresent = true
	diagnostic.Live = state.live
	diagnostic.Misses = state.misses
	diagnostic.SessionReason = "probe-miss"
	diagnostic.LastSessionChangeAt = timePointer(now)
	s.diag.targets[target.Identity] = diagnostic
}

func (s *targetStore) snapshot() []Session {
	s.mu.Lock()

	defer s.mu.Unlock()

	s.expireStaleSessionsLocked(s.now())

	result := make([]Session, 0, len(s.records))

	for _, record := range s.records {
		if record.session == nil || !record.session.visible() || !record.session.live {
			continue
		}

		result = append(result, Session{
			Identity: record.target.Identity,
			Mac:      record.target.MAC,
			Live:     true,
			Power2G:  record.session.power2G,
			Power5G:  record.session.power5G,
		})
	}

	for _, record := range s.records {
		if record.session == nil || !record.session.visible() || record.session.live {
			continue
		}

		result = append(result, Session{
			Identity: record.target.Identity,
			Mac:      record.target.MAC,
			Live:     false,
			Power2G:  record.session.power2G,
			Power5G:  record.session.power5G,
		})
	}

	sort.Slice(result, func(i, j int) bool { return result[i].Mac < result[j].Mac })

	return result
}

func (s *targetStore) has(identity string) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.hasLocked(identity)
}

func (s *targetStore) hasLocked(identity string) bool {
	_, ok := s.records[identity]

	return ok
}

func (s *targetStore) lockFor(identity string) chan struct{} {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.lockForLocked(identity)
}

func (s *targetStore) lockForLocked(identity string) chan struct{} {
	return s.locks[identity]
}

func (s *targetStore) identities() []Target {
	s.mu.Lock()

	defer s.mu.Unlock()

	targets := make([]Target, 0, len(s.records))

	for _, record := range s.records {
		targets = append(targets, record.target)
	}

	return targets
}

func (s *targetStore) markDisconnected(reason string) {
	now := s.now()

	s.mu.Lock()

	defer s.mu.Unlock()

	for identity, record := range s.records {
		if record.session == nil {
			continue
		}

		state := record.session
		state.live = false

		if state.misses < 2 {
			state.misses = 2
		}

		diagnostic := s.diag.targets[identity]
		diagnostic.Present = true
		diagnostic.SessionPresent = true
		diagnostic.Live = false
		diagnostic.Misses = state.misses
		diagnostic.SessionReason = reason
		diagnostic.RemovedAt = nil
		diagnostic.LastSessionChangeAt = timePointer(now)
		s.diag.targets[identity] = diagnostic
	}

	targetCount, sessionCount := s.countsLocked()

	s.diag.setCountsLocked(targetCount, sessionCount)
}

func (s *targetStore) clear(reason string) {
	now := s.now()

	s.mu.Lock()

	defer s.mu.Unlock()

	removed := make([]string, 0, len(s.records))

	for identity := range s.records {
		s.diag.markTargetGoneLocked(identity, reason, now)

		removed = append(removed, identity)
	}

	if len(removed) > 0 {
		s.diag.recordTargetChangeLocked(reason, nil, removed, now)
	}

	s.records = make(map[string]targetRecord)
	s.locks = make(map[string]chan struct{})

	s.diag.setCountsLocked(0, 0)
	s.diag.pruneLocked()
}

func (s *targetStore) expireStaleSessionsLocked(now time.Time) {
	for identity, record := range s.records {
		if record.session == nil || record.session.lastSeenAt.IsZero() || now.Sub(record.session.lastSeenAt) <= s.retention {
			continue
		}

		delete(s.records, identity)
		s.diag.markTargetGoneLocked(identity, "retention-expired", now)
	}

	targetCount, sessionCount := s.countsLocked()

	s.diag.setCountsLocked(targetCount, sessionCount)
	s.diag.pruneLocked()
}

func (s *targetStore) countsLocked() (targetCount, sessionCount int) {
	for _, record := range s.records {
		targetCount++

		if record.session != nil && record.session.visible() {
			sessionCount++
		}
	}

	return targetCount, sessionCount
}

func (s *targetStore) updatePowerState(identity string, update func(*sessionState)) {
	s.mu.Lock()

	defer s.mu.Unlock()

	record, ok := s.records[identity]

	if !ok || record.session == nil {
		return
	}

	update(record.session)

	s.records[identity] = record
}

func (s *targetStore) setPowerState(identity string, index int, power PowerState) {
	s.updatePowerState(identity, func(state *sessionState) {
		if index == 0 {
			state.power2G = power

			return
		}

		state.power5G = power
	})
}

func (s *targetStore) markPowerUnavailable(identity string, index int) {
	s.updatePowerState(identity, func(state *sessionState) {
		if index == 0 {
			state.power2G = unavailablePower(state.power2G)

			return
		}

		state.power5G = unavailablePower(state.power5G)
	})
}
