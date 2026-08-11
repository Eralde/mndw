package session

import (
	"sync"
	"time"
)

// NodeState is deliberately separate from global credential state: one failed
// extender must not invalidate credentials accepted by the controller.
type NodeState string

const (
	NodeOffline NodeState = "offline"
	NodeOnline  NodeState = "online"
	NodeFailed  NodeState = "failed"
)

type Snapshot struct {
	ID            string
	State         NodeState
	LastConnected time.Time
	LastSuccess   time.Time
	NextRetry     time.Time
	Failures      int
}

type nodeState struct {
	Snapshot
	failureTimes []time.Time
}

type State struct {
	mu    sync.Mutex
	nodes map[string]*nodeState
}

func NewState() *State { return &State{nodes: make(map[string]*nodeState)} }

func (s *State) Ensure(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.nodes[id]; !ok {
		s.nodes[id] = &nodeState{Snapshot: Snapshot{ID: id, State: NodeOffline}}
	}
}

func (s *State) SetOnline(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	node := s.ensureLocked(id)
	node.State = NodeOnline
	node.Failures = 0
	node.failureTimes = nil
	node.NextRetry = time.Time{}
	if node.LastConnected.IsZero() {
		node.LastConnected = now
	}
}

// RecordSuccess records a successful authentication/check without changing the
// node's discovery state. Discovery and authentication have separate meanings.
func (s *State) RecordSuccess(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	node := s.ensureLocked(id)
	node.LastSuccess = now.UTC()
}

func (s *State) SetOffline(id string, now time.Time) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	node := s.ensureLocked(id)
	wasOnline := node.State == NodeOnline
	if wasOnline {
		node.LastConnected = now
	}
	node.State = NodeOffline
	return node.LastConnected, wasOnline
}

func (s *State) RecordFailure(id string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	node := s.ensureLocked(id)
	node.State = NodeOffline
	node.Failures++
	node.failureTimes = append(node.failureTimes, now)
	cutoff := now.Add(-10 * time.Minute)
	kept := node.failureTimes[:0]
	for _, failure := range node.failureTimes {
		if !failure.Before(cutoff) {
			kept = append(kept, failure)
		}
	}
	node.failureTimes = kept
	if len(kept) >= 5 {
		node.State = NodeFailed
		return true
	}
	node.NextRetry = now.Add(RetryDelay(len(kept), 30*time.Second))
	return false
}

func (s *State) Snapshots() []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Snapshot, 0, len(s.nodes))
	for _, node := range s.nodes {
		result = append(result, node.Snapshot)
	}
	return result
}

func (s *State) Snapshot(id string) (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	node, ok := s.nodes[id]
	if !ok {
		return Snapshot{}, false
	}
	return node.Snapshot, true
}

func (s *State) ensureLocked(id string) *nodeState {
	if node, ok := s.nodes[id]; ok {
		return node
	}
	node := &nodeState{Snapshot: Snapshot{ID: id, State: NodeOffline}}
	s.nodes[id] = node
	return node
}
