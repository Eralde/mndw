package rci

import (
	"errors"
	"strings"
	"testing"
)

func TestHTTPErrorIncludesStatus(t *testing.T) {
	err := &HTTPError{StatusCode: 503, Status: "503", Body: []byte("busy")}
	if !strings.Contains(err.Error(), "503") {
		t.Fatalf("HTTPError.Error() = %q, want status", err.Error())
	}
}

func TestQueryErrorUnwrapsCause(t *testing.T) {
	err := &QueryError{Index: 2, Path: "show..system", Err: ErrInvalidPath}
	if !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("errors.Is(QueryError, ErrInvalidPath) = false")
	}
}
