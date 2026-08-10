// Package chansem provides cancellable channel-token semaphores.
package chansem

import "context"

// Acquire takes one token from slots, waiting for capacity when necessary.
// It checks cancellation before selecting so an already-canceled context never
// acquires a token from an available slot.
func Acquire(ctx context.Context, slots chan struct{}) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Release returns one token to slots.
func Release(slots chan struct{}) {
	<-slots
}
