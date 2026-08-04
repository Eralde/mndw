package socket

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"mndwd/internal/rcisession/proxy"
)

const ProtocolVersion = 1

type Config struct {
	PluginID     string
	Allowed      bool
	MaxLineBytes int
	MaxInflight  int
	IdleTimeout  time.Duration
}

type TargetSummary struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	MAC      string `json:"mac"`
}

type Handler interface {
	Do(context.Context, proxy.Request) (proxy.Response, error)
	Targets(context.Context) ([]TargetSummary, error)
}

type wireFrame struct {
	Hello  *wireHello      `json:"hello,omitempty"`
	ID     int64           `json:"id,omitempty"`
	Op     string          `json:"op,omitempty"`
	Target string          `json:"target,omitempty"`
	Method string          `json:"method,omitempty"`
	Path   string          `json:"path,omitempty"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type wireHello struct {
	PluginID string `json:"pluginId"`
	Proto    int    `json:"proto"`
}

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func ServeConnection(ctx context.Context, connection net.Conn, config Config, handler Handler) error {
	if config.MaxLineBytes <= 0 {
		config.MaxLineBytes = 64 * 1024
	}
	if config.MaxInflight <= 0 {
		config.MaxInflight = 8
	}
	reader := newLineReader(connection, config.MaxLineBytes)
	connectionContext, cancel := context.WithCancel(ctx)
	defer cancel()
	var writeMu sync.Mutex
	write := func(value any) error {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, err = connection.Write(append(data, '\n'))
		return err
	}

	if config.IdleTimeout > 0 {
		_ = connection.SetReadDeadline(time.Now().Add(config.IdleTimeout))
	}
	first, err := reader.next()
	if err != nil {
		return err
	}
	if first.Hello == nil {
		_ = write(map[string]any{"id": first.ID, "error": wireError{Code: "bad-request", Message: "hello must be first"}})
		return fmt.Errorf("hello required")
	}
	if first.Hello.Proto != ProtocolVersion || first.Hello.PluginID != config.PluginID || !config.Allowed {
		_ = write(map[string]any{"error": wireError{Code: "not-permitted", Message: "plugin is not permitted"}})
		return fmt.Errorf("plugin hello rejected")
	}
	if err := write(map[string]any{"hello": map[string]any{"proto": ProtocolVersion, "ok": true}}); err != nil {
		return err
	}

	semaphore := make(chan struct{}, config.MaxInflight)
	var workers sync.WaitGroup
	for {
		if config.IdleTimeout > 0 {
			_ = connection.SetReadDeadline(time.Now().Add(config.IdleTimeout))
		}
		frame, err := reader.next()
		if err != nil {
			workers.Wait()
			return err
		}
		if frame.ID <= 0 {
			_ = write(map[string]any{"error": wireError{Code: "bad-request", Message: "id must be positive"}})
			workers.Wait()
			return fmt.Errorf("invalid request id")
		}
		select {
		case semaphore <- struct{}{}:
		case <-connectionContext.Done():
			workers.Wait()
			return connectionContext.Err()
		}
		workers.Add(1)
		go func(frame wireFrame) {
			defer workers.Done()
			defer func() { <-semaphore }()
			if frame.Op == "targets" {
				targets, err := handler.Targets(connectionContext)
				if err != nil {
					_ = writeError(write, frame.ID, err)
					return
				}
				_ = write(map[string]any{"id": frame.ID, "targets": targets})
				return
			}
			response, err := handler.Do(connectionContext, proxy.Request{Target: frame.Target, Method: frame.Method, Path: frame.Path, Body: frame.Body})
			if err != nil {
				_ = writeError(write, frame.ID, err)
				return
			}
			body := json.RawMessage(response.Body)
			if !json.Valid(body) {
				body, _ = json.Marshal(string(response.Body))
			}
			_ = write(map[string]any{"id": frame.ID, "status": response.Status, "body": body})
		}(frame)
	}
}

func writeError(write func(any) error, id int64, err error) error {
	code := "internal-error"
	switch {
	case errors.Is(err, proxy.ErrBadRequest):
		code = "bad-request"
	case errors.Is(err, proxy.ErrNoSession):
		code = "no-session-for-target"
	case errors.Is(err, proxy.ErrUnsupported):
		code = "unsupported-firmware"
	case errors.Is(err, proxy.ErrSessionInvalid):
		code = "session-invalid"
	case errors.Is(err, proxy.ErrTargetUnreachable):
		code = "target-unreachable"
	}
	return write(map[string]any{"id": id, "error": wireError{Code: code, Message: code}})
}

type lineReader struct {
	connection net.Conn
	max        int
	buffer     []byte
}

func newLineReader(connection net.Conn, max int) *lineReader {
	return &lineReader{connection: connection, max: max}
}

func (r *lineReader) next() (wireFrame, error) {
	for {
		chunk := make([]byte, 4096)
		n, err := r.connection.Read(chunk)
		if n > 0 {
			r.buffer = append(r.buffer, chunk[:n]...)
			if len(r.buffer) > r.max {
				return wireFrame{}, fmt.Errorf("request line exceeds limit")
			}
			for index, value := range r.buffer {
				if value != '\n' {
					continue
				}
				line := append([]byte(nil), r.buffer[:index]...)
				r.buffer = append([]byte(nil), r.buffer[index+1:]...)
				var frame wireFrame
				decoder := json.NewDecoder(bytes.NewReader(line))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&frame); err != nil {
					return wireFrame{}, fmt.Errorf("invalid JSON frame")
				}
				return frame, nil
			}
		}
		if err != nil {
			return wireFrame{}, err
		}
	}
}
