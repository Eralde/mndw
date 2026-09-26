package main

import (
	"errors"
	"fmt"
)

// cleanupStack runs registered closers newest first, the way deferred calls
// unwind. Every closer runs even when an earlier one fails.
type cleanupStack struct {
	closers []namedCloser
}

type namedCloser struct {
	name    string
	closeFn func() error
}

func (s *cleanupStack) push(name string, closeFn func() error) {
	s.closers = append(s.closers, namedCloser{name: name, closeFn: closeFn})
}

// closeAll runs every closer once, newest first, and joins their errors, each
// prefixed with its closer name. A second call is a no-op.
func (s *cleanupStack) closeAll() error {
	closers := s.closers
	s.closers = nil

	var errs []error

	for index := len(closers) - 1; index >= 0; index-- {
		if err := closers[index].closeFn(); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", closers[index].name, err))
		}
	}

	return errors.Join(errs...)
}
