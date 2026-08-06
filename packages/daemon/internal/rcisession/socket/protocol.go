package socket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"time"

	"mndw.local/rcisock"
	"mndwd/internal/rcisession/proxy"
)

type Config struct {
	PluginID     string
	Allowed      bool
	Logger       *slog.Logger
	MaxLineBytes int
	MaxInflight  int
	IdleTimeout  time.Duration
}

type Handler interface {
	Do(context.Context, proxy.Request) (proxy.Response, error)
	Targets(context.Context) ([]rcisock.Target, error)
}

func ServeConnection(ctx context.Context, connection net.Conn, config Config, handler Handler) error {
	if config.MaxLineBytes <= 0 {
		config.MaxLineBytes = 64 * 1024
	}
	if config.MaxInflight <= 0 {
		config.MaxInflight = 8
	}
	reader := rcisock.NewReader[rcisock.RequestFrame](connection, config.MaxLineBytes)
	connectionContext, cancel := context.WithCancel(ctx)
	defer cancel()
	var writeMu sync.Mutex
	write := func(frame any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		deadlineSet := false
		if config.IdleTimeout > 0 {
			if err := connection.SetWriteDeadline(time.Now().Add(config.IdleTimeout)); err != nil {
				return err
			}
			deadlineSet = true
		}
		writeErr := rcisock.WriteFrame(connection, frame)
		var clearErr error
		if deadlineSet {
			clearErr = connection.SetWriteDeadline(time.Time{})
		}
		if writeErr != nil {
			return writeErr
		}
		return clearErr
	}

	if config.IdleTimeout > 0 {
		_ = connection.SetReadDeadline(time.Now().Add(config.IdleTimeout))
	}
	first, err := readRequestFrame(reader)
	if err != nil {
		return err
	}
	if first.Hello == nil {
		id := first.ID
		_ = write(rcisock.ResponseFrame{ID: &id, Error: &rcisock.Error{Code: "bad-request", Message: "hello must be first"}})
		return fmt.Errorf("hello required")
	}
	if first.Hello.Proto != rcisock.ProtocolVersion || first.Hello.PluginID != config.PluginID || !config.Allowed {
		_ = write(rcisock.ResponseFrame{Error: &rcisock.Error{Code: "not-permitted", Message: "plugin is not permitted"}})
		return fmt.Errorf("plugin hello rejected")
	}
	if err := write(rcisock.ResponseFrame{Hello: &rcisock.ServerHello{Proto: rcisock.ProtocolVersion, OK: true}}); err != nil {
		return err
	}
	if config.Logger != nil {
		config.Logger.Debug("persistent RCI socket hello accepted", "plugin", config.PluginID)
	}

	semaphore := make(chan struct{}, config.MaxInflight)
	var workers sync.WaitGroup
	for {
		if config.IdleTimeout > 0 {
			_ = connection.SetReadDeadline(time.Now().Add(config.IdleTimeout))
		}
		frame, err := readRequestFrame(reader)
		if err != nil {
			workers.Wait()
			return err
		}
		if frame.ID <= 0 {
			_ = write(rcisock.ResponseFrame{Error: &rcisock.Error{Code: "bad-request", Message: "id must be positive"}})
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
		go func(frame rcisock.RequestFrame) {
			defer workers.Done()
			defer func() { <-semaphore }()
			if frame.Op == "targets" {
				targets, err := handler.Targets(connectionContext)
				if err != nil {
					logRequestError(config.Logger, "persistent RCI target enumeration failed", config.PluginID, protocolErrorCode(err))
					_ = writeError(write, frame.ID, err)
					return
				}
				if config.Logger != nil {
					config.Logger.Debug("persistent RCI targets enumerated", "plugin", config.PluginID, "count", len(targets))
				}
				id := frame.ID
				_ = write(rcisock.ResponseFrame{ID: &id, Targets: targets})
				return
			}
			response, err := handler.Do(connectionContext, proxy.Request{Target: frame.Target, Method: frame.Method, Path: frame.Path, Body: frame.Body})
			if err != nil {
				logRequestError(config.Logger, "persistent RCI request failed", config.PluginID, protocolErrorCode(err), "target", frame.Target, "method", frame.Method, "path", frame.Path)
				_ = writeError(write, frame.ID, err)
				return
			}
			if config.Logger != nil {
				config.Logger.Debug("persistent RCI request completed", "plugin", config.PluginID, "target", frame.Target, "method", frame.Method, "path", frame.Path, "status", response.Status)
			}
			body := json.RawMessage(response.Body)
			if !json.Valid(body) {
				body, _ = json.Marshal(string(response.Body))
			}
			id := frame.ID
			_ = write(rcisock.ResponseFrame{ID: &id, Status: response.Status, Body: body})
		}(frame)
	}
}

func readRequestFrame(reader *rcisock.Reader[rcisock.RequestFrame]) (rcisock.RequestFrame, error) {
	frame, err := reader.Next()
	if err == nil {
		return frame, nil
	}
	if errors.Is(err, io.EOF) {
		return rcisock.RequestFrame{}, err
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return rcisock.RequestFrame{}, err
	}
	if !errors.Is(err, rcisock.ErrMalformedFrame) {
		return rcisock.RequestFrame{}, err
	}
	return rcisock.RequestFrame{}, fmt.Errorf("%w: invalid request frame: %v", proxy.ErrBadRequest, err)
}

func writeError(write func(any) error, id int64, err error) error {
	code := protocolErrorCode(err)
	return write(rcisock.ResponseFrame{ID: &id, Error: &rcisock.Error{Code: code, Message: code}})
}

func protocolErrorCode(err error) string {
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
	case errors.Is(err, proxy.ErrSecureEndpointUnavailable):
		code = "target-unreachable"
	case errors.Is(err, proxy.ErrTargetUnreachable):
		code = "target-unreachable"
	}
	return code
}

func logRequestError(logger *slog.Logger, message, plugin, code string, attributes ...any) {
	if logger == nil {
		return
	}
	level := slog.LevelWarn
	if code == "no-session-for-target" || code == "unsupported-firmware" {
		level = slog.LevelDebug
	}
	args := append([]any{"plugin", plugin, "code", code}, attributes...)
	logger.Log(context.Background(), level, message, args...)
}
