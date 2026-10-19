package rcisock

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const ProtocolVersion = 1

var ErrMalformedFrame = errors.New("rcisock: malformed frame")

type RequestFrame struct {
	Hello  *ClientHello    `json:"hello,omitempty"`
	ID     int64           `json:"id,omitempty"`
	Op     string          `json:"op,omitempty"`
	Target string          `json:"target,omitempty"`
	Method string          `json:"method,omitempty"`
	Path   string          `json:"path,omitempty"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type ResponseFrame struct {
	Hello   *ServerHello    `json:"hello,omitempty"`
	ID      *int64          `json:"id,omitempty"`
	Status  int             `json:"status,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Targets []Target        `json:"targets,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

type ClientHello struct {
	PluginID string `json:"pluginId,omitempty"`
	Proto    int    `json:"proto"`
}

type ServerHello struct {
	Proto int  `json:"proto"`
	OK    bool `json:"ok,omitempty"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Target struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	MAC      string `json:"mac"`
}

type responseFrameWire struct {
	Hello   *ServerHello    `json:"hello,omitempty"`
	ID      *int64          `json:"id,omitempty"`
	Status  *int            `json:"status,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Targets *[]Target       `json:"targets,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

func (f ResponseFrame) MarshalJSON() ([]byte, error) {
	var status *int

	if f.Status != 0 || f.Body != nil {
		status = &f.Status
	}

	var targets *[]Target

	if f.Targets != nil {
		targets = &f.Targets
	}

	return json.Marshal(responseFrameWire{
		Hello: f.Hello, ID: f.ID, Status: status, Body: f.Body,
		Targets: targets, Error: f.Error,
	})
}

func WriteFrame(w io.Writer, frame any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}

	data = append(data, '\n')
	n, err := w.Write(data)
	if err != nil {
		return err
	}

	if n != len(data) {
		return io.ErrShortWrite
	}

	return nil
}

type Reader[T any] struct {
	reader      io.Reader
	max         int
	buffer      []byte
	terminalErr error
}

func NewReader[T any](reader io.Reader, maxFrameBytes int) *Reader[T] {
	if maxFrameBytes <= 0 {
		maxFrameBytes = 1
	}

	return &Reader[T]{reader: reader, max: maxFrameBytes}
}

func (r *Reader[T]) Next() (T, error) {
	var zero T

	for {
		if index := bytes.IndexByte(r.buffer, '\n'); index >= 0 {
			if index > r.max {
				return zero, fmt.Errorf("%w: frame exceeds maximum size %d", ErrMalformedFrame, r.max)
			}

			line := append([]byte(nil), r.buffer[:index]...)
			r.buffer = r.buffer[index+1:]
			var frame T
			decoder := json.NewDecoder(bytes.NewReader(line))

			decoder.DisallowUnknownFields()

			if err := decoder.Decode(&frame); err != nil {
				return zero, fmt.Errorf("%w: decode frame: %v", ErrMalformedFrame, err)
			}

			var extra any

			if err := decoder.Decode(&extra); err != io.EOF {
				if err == nil {
					return zero, fmt.Errorf("%w: decode frame: multiple JSON values", ErrMalformedFrame)
				}

				return zero, fmt.Errorf("%w: decode frame: trailing JSON: %v", ErrMalformedFrame, err)
			}

			return frame, nil
		}

		if len(r.buffer) > r.max {
			return zero, fmt.Errorf("%w: frame exceeds maximum size %d", ErrMalformedFrame, r.max)
		}

		if r.terminalErr != nil {
			err := r.terminalErr
			r.terminalErr = nil

			return zero, err
		}

		chunk := make([]byte, 4096)
		n, err := r.reader.Read(chunk)

		if n > 0 {
			r.buffer = append(r.buffer, chunk[:n]...)
		}

		if err != nil {
			r.terminalErr = err
		}

		if n == 0 && err == nil {
			continue
		}
	}
}
