package backend

import "errors"

// ErrServiceCapacityExceeded indicates that no supervised-service slot is available.
var ErrServiceCapacityExceeded = errors.New("service capacity exceeded")
