package rci

import (
	"errors"
	"fmt"
	"strconv"
)

var (
	ErrInvalidBaseURL   = errors.New("rci: invalid base URL")
	ErrNilTransport     = errors.New("rci: nil transport")
	ErrNilHTTPClient    = errors.New("rci: nil HTTP client")
	ErrInvalidPath      = errors.New("rci: invalid query path")
	ErrInvalidResponse  = errors.New("rci: malformed response")
	ErrResponseTooLarge = errors.New("rci: response exceeds size limit")
)

type HTTPError struct {
	StatusCode int
	Status     string
	Body       []byte
}

func (e *HTTPError) Error() string {
	status := e.Status
	if status == "" {
		status = strconv.Itoa(e.StatusCode)
	}
	return fmt.Sprintf("rci: HTTP status %s", status)
}

type QueryError struct {
	Index int
	Path  string
	Err   error
}

func (e *QueryError) Error() string {
	return fmt.Sprintf("rci: query %d (%s): %v", e.Index, e.Path, e.Err)
}

func (e *QueryError) Unwrap() error {
	return e.Err
}
