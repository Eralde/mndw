package credentials

import (
	"sync"
)

// State is the global controller credential verdict.
type State string

const (
	StateAbsent  State = "absent"
	StatePresent State = "present"
	StateInvalid State = "invalid"
)

// Snapshot is a short-lived copy. Callers must not retain it after an
// authentication attempt.
type Snapshot struct {
	Username string
	Password []byte
	Epoch    uint64
}

// Store owns credentials and their verdict. Password bytes are wiped on every
// replacement and forget.
type Store struct {
	mu       sync.Mutex
	username []byte
	password []byte
	state    State
	epoch    uint64
}

func NewStore() *Store { return &Store{state: StateAbsent} }

func (s *Store) Set(username string, password []byte, epoch uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	zero(s.username)
	zero(s.password)
	s.username = append([]byte(nil), username...)
	s.password = append([]byte(nil), password...)
	s.state = StatePresent
	s.epoch = epoch
}

func (s *Store) MarkInvalid(epoch uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch < s.epoch {
		return
	}
	zero(s.username)
	zero(s.password)
	s.username = nil
	s.password = nil
	s.state = StateInvalid
	s.epoch = epoch
}

func (s *Store) Forget(epoch uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch < s.epoch {
		return
	}
	zero(s.username)
	zero(s.password)
	s.username = nil
	s.password = nil
	s.state = StateAbsent
	s.epoch = epoch
}

func (s *Store) Snapshot() (Snapshot, State, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != StatePresent {
		return Snapshot{Epoch: s.epoch}, s.state, false
	}
	return Snapshot{Username: string(s.username), Password: append([]byte(nil), s.password...), Epoch: s.epoch}, s.state, true
}

func (s *Store) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Store) Epoch() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.epoch
}

func zero(buffer []byte) {
	for index := range buffer {
		buffer[index] = 0
	}
}
