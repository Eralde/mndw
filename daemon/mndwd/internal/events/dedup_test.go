package events

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDeduplicatorAcceptsConcurrentIdenticalHookOnce(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	event := Event{
		ID:      "1",
		Topic:   "interface.state",
		Source:  "hook",
		Payload: []byte(`{"interface":"Wireguard0"}`),
	}

	for round := range 100 {
		deduplicator := NewDeduplicator(func() time.Time { return now })
		start := make(chan struct{})
		var accepted atomic.Int32
		var wait sync.WaitGroup

		wait.Add(8)

		for range 8 {
			go func() {
				defer wait.Done()

				<-start

				if deduplicator.Accept(event) {
					accepted.Add(1)
				}
			}()
		}

		close(start)
		wait.Wait()

		if got := accepted.Load(); got != 1 {
			t.Fatalf("round %d accepted identical hook %d times, want 1", round, got)
		}
	}
}

func TestDeduplicatorConcurrentMixedSources(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	deduplicator := NewDeduplicator(func() time.Time { return now })
	matchingLogs := make([]Event, 50)
	newHooks := make([]Event, 50)

	for i := range 50 {
		key := fmt.Sprintf("Wireguard%d", i)
		payload := []byte(fmt.Sprintf(`{"interface":%q}`, key))
		hook := Event{
			ID:      fmt.Sprintf("hook-%d", i),
			Topic:   "interface.state",
			Source:  "hook",
			Payload: payload,
		}

		if !deduplicator.Accept(hook) {
			t.Fatalf("initial hook %d was rejected", i)
		}

		matchingLogs[i] = Event{
			ID:      fmt.Sprintf("log-%d", i),
			Topic:   "interface.state",
			Source:  "log",
			Payload: payload,
		}
		newHooks[i] = Event{
			ID:      fmt.Sprintf("new-hook-%d", i),
			Topic:   "interface.state",
			Source:  "hook",
			Payload: []byte(fmt.Sprintf(`{"interface":%q}`, fmt.Sprintf("Other%d", i))),
		}
	}

	start := make(chan struct{})
	logResults := make(chan bool, len(matchingLogs))
	hookResults := make(chan bool, len(newHooks))
	var wait sync.WaitGroup

	wait.Add(8)

	for worker := range 4 {
		go func() {
			defer wait.Done()

			<-start

			for i := worker; i < len(matchingLogs); i += 4 {
				logResults <- deduplicator.Accept(matchingLogs[i])
			}
		}()

		go func() {
			defer wait.Done()

			<-start

			for i := worker; i < len(newHooks); i += 4 {
				hookResults <- deduplicator.Accept(newHooks[i])
			}
		}()
	}

	close(start)
	wait.Wait()
	close(logResults)
	close(hookResults)

	for i := 0; i < len(matchingLogs); i++ {
		accepted := <-logResults

		if accepted {
			t.Errorf("matching log event %d was accepted, want rejected", i)
		}
	}

	for i := 0; i < len(newHooks); i++ {
		accepted := <-hookResults

		if !accepted {
			t.Errorf("new hook event %d was rejected, want accepted", i)
		}
	}
}
