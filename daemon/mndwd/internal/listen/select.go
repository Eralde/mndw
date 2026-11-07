// Package listen selects and binds the mndwd front-door listener.
package listen

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// DefaultPort is the fresh-install front-door port.
const DefaultPort = 1189

// DefaultFallbackPorts is 1189..1289 ascending.
var DefaultFallbackPorts = buildFallback()

func buildFallback() []int {
	ports := make([]int, 0, 101)

	for port := 1189; port <= 1289; port++ {
		ports = append(ports, port)
	}

	return ports
}

// Config parameterizes Select.
type Config struct {
	BindAddr      string
	PersistPath   string
	SeedPath      string
	DefaultPort   int
	FallbackPorts []int
	RetryAttempts int
	RetryDelay    time.Duration
}

// Selection describes the listener chosen by Select and whether it replaced
// an unavailable preferred port.
type Selection struct {
	Listener      net.Listener
	Port          int
	PreferredPort int
	UsedFallback  bool
}

// Select determines the preferred port (persisted, migration seed, or default),
// binds it with a bounded retry, then falls back to FallbackPorts only when a
// port is already in use. It persists the winning port and returns the held
// listener and selection details.
func Select(cfg Config) (Selection, error) {
	if cfg.RetryAttempts < 1 {
		cfg.RetryAttempts = 1
	}

	preferred, hasPreferred := cfg.preferredPort()
	var preferredErr error

	if hasPreferred {
		listener, err := cfg.bindWithRetry(preferred)
		if err == nil {
			return cfg.finish(listener, preferred, preferred, false)
		}

		preferredErr = err

		if !errors.Is(err, syscall.EADDRINUSE) {
			return Selection{}, err
		}
	}

	var lastBusyErr error

	for _, port := range cfg.FallbackPorts {
		if hasPreferred && port == preferred {
			continue
		}

		listener, err := cfg.bindOnce(port)
		if err == nil {
			return cfg.finish(listener, port, preferred, hasPreferred)
		}

		if !errors.Is(err, syscall.EADDRINUSE) {
			return Selection{}, err
		}

		lastBusyErr = err
	}

	busyErr := preferredErr

	if busyErr == nil {
		busyErr = lastBusyErr
	}

	message := fmt.Sprintf("no front-door port available: tried preferred %d and range 1189..1289", preferred)

	if busyErr != nil {
		return Selection{}, fmt.Errorf("%s: %w", message, busyErr)
	}

	return Selection{}, errors.New(message)
}

func (c Config) preferredPort() (int, bool) {
	if port, ok := readPortFile(c.PersistPath); ok {
		return port, true
	}

	if port, ok := readPortFile(c.SeedPath); ok {
		return port, true
	}

	if c.DefaultPort > 0 {
		return c.DefaultPort, true
	}

	return 0, false
}

func (c Config) bindWithRetry(port int) (net.Listener, error) {
	var lastErr error

	for attempt := 0; attempt < c.RetryAttempts; attempt++ {
		listener, err := c.bindOnce(port)
		if err == nil {
			return listener, nil
		}

		lastErr = err

		if !errors.Is(err, syscall.EADDRINUSE) {
			return nil, err
		}

		if attempt < c.RetryAttempts-1 {
			time.Sleep(c.RetryDelay)
		}
	}

	return nil, lastErr
}

func (c Config) bindOnce(port int) (net.Listener, error) {
	address := net.JoinHostPort(c.BindAddr, strconv.Itoa(port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", address, err)
	}

	return listener, nil
}

func (c Config) finish(listener net.Listener, port, preferred int, usedFallback bool) (Selection, error) {
	if err := writePortAtomic(c.PersistPath, port); err != nil {
		_ = listener.Close()

		return Selection{}, fmt.Errorf("persist front-door port: %w", err)
	}

	return Selection{Listener: listener, Port: port, PreferredPort: preferred, UsedFallback: usedFallback}, nil
}

func readPortFile(path string) (int, bool) {
	if path == "" {
		return 0, false
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}

	port, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || port <= 0 || port > 65535 {
		return 0, false
	}

	return port, true
}

func writePortAtomic(path string, port int) error {
	if path == "" {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	temporary, err := os.CreateTemp(filepath.Dir(path), ".frontend-port-*")
	if err != nil {
		return err
	}

	temporaryName := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}

	if _, err := temporary.WriteString(strconv.Itoa(port)); err != nil {
		cleanup()

		return err
	}

	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryName)

		return err
	}

	if err := os.Rename(temporaryName, path); err != nil {
		_ = os.Remove(temporaryName)

		return err
	}

	return nil
}
