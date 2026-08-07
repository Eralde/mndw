// Package socket exposes an authenticated RCI session to permitted builtin
// plugins over a per-plugin unix socket, and reconciles those sockets (create,
// keep, tear down) as the persistent credential state changes.
package socket

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Server struct {
	path    string
	config  Config
	handler Handler

	mu       sync.Mutex
	listener net.Listener
	conns    map[net.Conn]struct{}
	cancel   context.CancelFunc
	closing  bool
	wait     sync.WaitGroup
}

func NewServer(path string, config Config, handler Handler) *Server {
	return &Server{path: path, config: config, handler: handler, conns: make(map[net.Conn]struct{})}
}

func (s *Server) Start(ctx context.Context) error {
	if s.path == "" || s.handler == nil {
		return fmt.Errorf("socket path and handler are required")
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create socket directory: %w", err)
	}
	if err := os.Chmod(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("secure socket directory: %w", err)
	}
	if err := recoverSocketPath(s.path); err != nil {
		return err
	}
	listener, err := net.Listen("unix", s.path)
	if err != nil {
		return fmt.Errorf("listen on persistent RCI socket: %w", err)
	}
	if err := os.Chmod(s.path, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(s.path)
		return fmt.Errorf("secure persistent RCI socket: %w", err)
	}
	connectionContext, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.listener = listener
	s.cancel = cancel
	s.closing = false
	s.mu.Unlock()
	if s.config.Logger != nil {
		s.config.Logger.Info("persistent RCI socket started", "plugin", s.config.PluginID, "path", s.path)
	}
	s.wait.Add(1)
	go s.acceptLoop(connectionContext, listener)
	return nil
}

func (s *Server) Close() error {
	s.mu.Lock()
	s.closing = true
	listener := s.listener
	cancel := s.cancel
	connections := make([]net.Conn, 0, len(s.conns))
	for connection := range s.conns {
		connections = append(connections, connection)
	}
	s.listener = nil
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if listener != nil {
		_ = listener.Close()
	}
	for _, connection := range connections {
		_ = connection.Close()
	}
	s.wait.Wait()
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if s.config.Logger != nil {
		s.config.Logger.Info("persistent RCI socket stopped", "plugin", s.config.PluginID, "path", s.path)
	}
	return nil
}

func (s *Server) acceptLoop(ctx context.Context, listener net.Listener) {
	defer s.wait.Done()
	for {
		connection, err := listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
			}
			continue
		}
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			_ = connection.Close()
			continue
		}
		s.conns[connection] = struct{}{}
		s.mu.Unlock()
		if s.config.Logger != nil {
			s.config.Logger.Debug("persistent RCI socket connection accepted", "plugin", s.config.PluginID)
		}
		s.wait.Add(1)
		go func() {
			defer s.wait.Done()
			defer func() {
				s.mu.Lock()
				delete(s.conns, connection)
				s.mu.Unlock()
				_ = connection.Close()
			}()
			err := ServeConnection(ctx, connection, s.config, s.handler)
			if s.config.Logger == nil {
				return
			}
			if ctx.Err() != nil {
				s.config.Logger.Debug("persistent RCI socket connection ended", "plugin", s.config.PluginID, "reason", "server-shutdown")
				return
			}
			if err != nil {
				s.config.Logger.Warn("persistent RCI socket connection ended", "plugin", s.config.PluginID, "reason", socketErrorReason(err))
				return
			}
			s.config.Logger.Debug("persistent RCI socket connection ended", "plugin", s.config.PluginID, "reason", "closed")
		}()
	}
}

func socketErrorReason(err error) string {
	if errors.Is(err, context.Canceled) || errors.Is(err, net.ErrClosed) {
		return "closed"
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "idle-timeout"
	}
	return "protocol-error"
}

func recoverSocketPath(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect persistent RCI socket: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("persistent RCI socket path is not a Unix socket")
	}
	probe, err := net.DialTimeout("unix", path, 100*time.Millisecond)
	if err == nil {
		_ = probe.Close()
		return fmt.Errorf("persistent RCI socket listener is alive")
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale persistent RCI socket: %w", err)
	}
	return nil
}
