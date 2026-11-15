package httpx

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"time"
)

const (
	MaxJSONBodyBytes int64         = 64 << 10
	JSONBodyTimeout  time.Duration = 15 * time.Second
)

// BodyLimit selects the size and time bounds for one request body.
type BodyLimit struct {
	MaxBytes     int64
	Timeout      time.Duration
	TooLargeCode string
}

// BodyIntake limits the number of request bodies being buffered at once.
type BodyIntake struct {
	slots chan struct{}
}

// NewBodyIntake creates a request body intake limiter with the given capacity.
func NewBodyIntake(slots int) *BodyIntake {
	return &BodyIntake{slots: make(chan struct{}, slots)}
}

// Read reads the complete request body and replaces it with an in-memory copy.
func (i *BodyIntake) Read(w http.ResponseWriter, r *http.Request, limit BodyLimit) *APIError {
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		return nil
	}

	if r.ContentLength > limit.MaxBytes {
		return i.readError(w, NewError(http.StatusRequestEntityTooLarge, limit.TooLargeCode, "request body is too large"))
	}

	select {
	case i.slots <- struct{}{}:
		defer func() { <-i.slots }()
	default:
		w.Header().Set("Retry-After", "1")

		return i.readError(w, NewError(http.StatusServiceUnavailable, CodeServerBusy, "request body intake is busy"))
	}

	controller := http.NewResponseController(w)
	deadlineArmed := false

	if limit.Timeout > 0 {
		err := controller.SetReadDeadline(time.Now().Add(limit.Timeout))
		if err == nil {
			deadlineArmed = true
		} else if !errors.Is(err, http.ErrNotSupported) {
			return i.readError(w, unreadableBodyError())
		}
	}

	if r.ContentLength >= 0 {
		if r.ContentLength > int64(maxInt()) {
			return i.readError(w, NewError(http.StatusRequestEntityTooLarge, limit.TooLargeCode, "request body is too large"))
		}

		body := make([]byte, int(r.ContentLength))

		if _, err := io.ReadFull(r.Body, body); err != nil {
			return i.readError(w, requestBodyError(err, limit.TooLargeCode))
		}

		if deadlineArmed {
			if err := controller.SetReadDeadline(time.Time{}); err != nil {
				return i.readError(w, unreadableBodyError())
			}

			deadlineArmed = false
		}

		var extra [1]byte
		n, err := r.Body.Read(extra[:])

		if n != 0 {
			if limit.Timeout > 0 {
				_ = controller.SetReadDeadline(time.Now().Add(limit.Timeout))
			}

			return i.readError(w, unreadableBodyError())
		}

		if !errors.Is(err, io.EOF) {
			if limit.Timeout > 0 {
				_ = controller.SetReadDeadline(time.Now().Add(limit.Timeout))
			}

			return i.readError(w, requestBodyError(err, limit.TooLargeCode))
		}

		i.replaceBody(r, body)

		return nil
	}

	bounded := http.MaxBytesReader(w, r.Body, limit.MaxBytes)
	body, err := io.ReadAll(bounded)
	if err != nil {
		return i.readError(w, requestBodyError(err, limit.TooLargeCode))
	}

	if deadlineArmed {
		if err := controller.SetReadDeadline(time.Time{}); err != nil {
			return i.readError(w, unreadableBodyError())
		}
	}

	i.replaceBody(r, body)

	return nil
}

// Middleware reads each request body with the bound selected by limitFor.
func (i *BodyIntake) Middleware(limitFor func(*http.Request) BodyLimit, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiErr := i.Read(w, r, limitFor(r)); apiErr != nil {
			WriteError(w, nil, apiErr)

			return
		}

		next.ServeHTTP(w, r)
	})
}

// ArmBodyDeadline bounds reads of bodies rejected before body intake. BodyIntake
// replaces this connection deadline when routing admits a body.
func ArmBodyDeadline(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hasBody := r.Body != nil && r.Body != http.NoBody && r.ContentLength != 0

		if hasBody && timeout > 0 {
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(timeout))
		}

		next.ServeHTTP(w, r)
	})
}

// replaceBody installs a length-delimited buffered body. Request trailers are not forwarded after buffering.
func (i *BodyIntake) replaceBody(r *http.Request, body []byte) {
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.TransferEncoding = nil
	r.Trailer = nil
	r.GetBody = nil
}

func (i *BodyIntake) readError(w http.ResponseWriter, apiErr *APIError) *APIError {
	w.Header().Set("Connection", "close")

	return apiErr
}

func requestBodyError(err error, tooLargeCode string) *APIError {
	var tooLarge *http.MaxBytesError

	if errors.As(err, &tooLarge) {
		return NewError(http.StatusRequestEntityTooLarge, tooLargeCode, "request body is too large")
	}

	var networkErr net.Error

	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return NewError(http.StatusRequestTimeout, CodeRequestTimeout, "request body timed out")
	}

	return unreadableBodyError()
}

func unreadableBodyError() *APIError {
	return NewError(http.StatusBadRequest, CodeBadRequest, "request body is unreadable")
}

func maxInt() int {
	return int(^uint(0) >> 1)
}
