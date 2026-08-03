package socket

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultIOTimeout     = 5 * time.Second
	defaultAuthTimeout   = 15 * time.Second
	defaultRequestLimit  = 128 << 10
	defaultResponseLimit = 512 << 10
)

type Service interface {
	Credentials(context.Context, string, string) (any, error)
	Forget(context.Context) (any, error)
	Nodes(context.Context) (any, error)
	Snapshot(context.Context, string) (any, error)
}

type Server struct {
	Path          string
	PIDPath       string
	IOTimeout     time.Duration
	AuthTimeout   time.Duration
	RequestLimit  int64
	ResponseLimit int64
	Service       Service
	listener      net.Listener
}

func (s *Server) Listen() error {
	if s.IOTimeout <= 0 {
		s.IOTimeout = defaultIOTimeout
	}
	if s.AuthTimeout <= 0 {
		s.AuthTimeout = defaultAuthTimeout
	}
	if s.RequestLimit <= 0 {
		s.RequestLimit = defaultRequestLimit
	}
	if s.ResponseLimit <= 0 {
		s.ResponseLimit = defaultResponseLimit
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(s.Path); err == nil {
		if !staleSocket(s.Path, s.PIDPath) {
			return fmt.Errorf("socket already running")
		}
		if err := os.Remove(s.Path); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", s.Path)
	if err != nil {
		return err
	}
	if err := os.Chmod(s.Path, 0o600); err != nil {
		_ = listener.Close()
		return err
	}
	s.listener = listener
	if s.PIDPath != "" {
		if err := os.WriteFile(s.PIDPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
			_ = listener.Close()
			return err
		}
	}
	return nil
}

func (s *Server) Serve(ctx context.Context) error {
	if s.listener == nil {
		return fmt.Errorf("socket is not listening")
	}
	go func() { <-ctx.Done(); _ = s.listener.Close() }()
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			continue
		}
		go s.serveConnection(connection)
	}
}

func (s *Server) Close() error {
	if s.listener != nil {
		_ = s.listener.Close()
	}
	if s.PIDPath != "" {
		_ = os.Remove(s.PIDPath)
	}
	return nil
}

func (s *Server) serveConnection(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(s.IOTimeout))
	reader := bufio.NewReader(io.LimitReader(connection, s.RequestLimit+1))
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return
	}
	if len(line) == 0 || line[len(line)-1] != '\n' {
		s.write(connection, Failure(400, "BAD_REQUEST", "newline-delimited request required"))
		return
	}
	if int64(len(line)) > s.RequestLimit {
		s.write(connection, Failure(413, "REQUEST_TOO_LARGE", "request exceeds size limit"))
		return
	}
	line = []byte(strings.TrimSpace(string(line)))
	request, err := DecodeRequest(line)
	if err != nil {
		s.write(connection, Failure(400, "BAD_REQUEST", err.Error()))
		return
	}
	// Only inspect bytes already buffered. Waiting for another byte would block
	// clients that keep the connection open while waiting for the response.
	if reader.Buffered() > 0 {
		s.write(connection, Failure(400, "BAD_REQUEST", "one request per connection"))
		return
	}
	operation := context.Background()
	deadline := s.IOTimeout
	if request.Command == CommandCredentials {
		deadline = s.AuthTimeout
	}
	operation, cancel := context.WithTimeout(operation, deadline)
	defer cancel()
	response := s.dispatch(operation, request)
	s.write(connection, response)
}

func (s *Server) dispatch(ctx context.Context, request Request) Response {
	if s.Service == nil {
		return Failure(502, "SERVICE_UNAVAILABLE", "mwsd service unavailable")
	}
	var data any
	var err error
	switch request.Command {
	case CommandCredentials:
		data, err = s.Service.Credentials(ctx, request.Username, request.Password)
	case CommandForget:
		data, err = s.Service.Forget(ctx)
	case CommandNodes:
		data, err = s.Service.Nodes(ctx)
	case CommandSnapshot:
		data, err = s.Service.Snapshot(ctx, request.NodeID)
	}
	if err != nil {
		var statusErr interface {
			Status() int
			Code() string
		}
		if errors.As(err, &statusErr) {
			return Failure(statusErr.Status(), statusErr.Code(), err.Error())
		}
		return Failure(502, "BACKEND_FAILED", "mwsd operation failed")
	}
	return Success(data)
}

func (s *Server) write(connection net.Conn, response Response) {
	data, err := EncodeResponse(response)
	if err != nil {
		data, _ = EncodeResponse(Failure(500, "INTERNAL", "response encoding failed"))
	}
	data = append(data, '\n')
	if int64(len(data)) > s.ResponseLimit {
		data, _ = EncodeResponse(Failure(502, "RESPONSE_TOO_LARGE", "response exceeds size limit"))
		data = append(data, '\n')
	}
	_ = connection.SetWriteDeadline(time.Now().Add(s.IOTimeout))
	_, _ = connection.Write(data)
}

func staleSocket(socketPath, pidPath string) bool {
	if pidPath == "" {
		return false
	}
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return errors.Is(err, os.ErrNotExist)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return true
	}
	return syscall.Kill(pid, 0) != nil
}
