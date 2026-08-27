// Package clock provides a minimal injectable time source shared across the
// mwsd internal packages.
package clock

import "time"

// Clock is a source of the current time. Tests inject a fake; production uses Real().
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// Real returns a Clock backed by time.Now.
func Real() Clock { return realClock{} }
