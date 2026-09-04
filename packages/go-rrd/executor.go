package rrd

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	defaultOutputLimit = 1 << 20
	maxArgumentCount   = 64
	maxArgumentBytes   = 16 << 10
)

var ErrOutputLimit = errors.New("rrd: command output limit exceeded")

type ExecResult struct {
	Stdout []byte
	Stderr []byte
}

type Executor interface {
	Run(context.Context, ...string) (ExecResult, error)
}

type ExecutorOption func(*executorConfig)

type executorConfig struct {
	outputLimit     int
	clock           func() time.Time
	warningObserver func(string, []byte)
	warningInterval time.Duration
}

type executor struct {
	binary          string
	outputLimit     int
	clock           func() time.Time
	warningObserver func(string, []byte)
	warningInterval time.Duration

	mu             sync.Mutex
	lastWarning    time.Time
	hasLastWarning bool
}

func NewExecutor(binary string, opts ...ExecutorOption) Executor {
	config := executorConfig{
		outputLimit:     defaultOutputLimit,
		clock:           time.Now,
		warningInterval: time.Minute,
	}

	for _, opt := range opts {
		if opt != nil {
			opt(&config)
		}
	}

	if config.outputLimit <= 0 {
		config.outputLimit = defaultOutputLimit
	}

	if config.clock == nil {
		config.clock = time.Now
	}

	return &executor{
		binary:          binary,
		outputLimit:     config.outputLimit,
		clock:           config.clock,
		warningObserver: config.warningObserver,
		warningInterval: config.warningInterval,
	}
}

func WithOutputLimit(maxBytes int) ExecutorOption {
	return func(config *executorConfig) {
		config.outputLimit = maxBytes
	}
}

func WithWarningObserver(observer func(string, []byte)) ExecutorOption {
	return func(config *executorConfig) {
		config.warningObserver = observer
	}
}

func WithClock(clock func() time.Time) ExecutorOption {
	return func(config *executorConfig) {
		config.clock = clock
	}
}

func WithWarningInterval(interval time.Duration) ExecutorOption {
	return func(config *executorConfig) {
		config.warningInterval = interval
	}
}

func (e *executor) Run(ctx context.Context, args ...string) (ExecResult, error) {
	if e.binary == "" {
		return ExecResult{}, errors.New("rrd: empty executable path")
	}

	if len(args) > maxArgumentCount {
		return ExecResult{}, fmt.Errorf("rrd: too many command arguments: %d", len(args))
	}

	for _, arg := range args {
		if len(arg) > maxArgumentBytes {
			return ExecResult{}, fmt.Errorf("rrd: command argument exceeds %d bytes", maxArgumentBytes)
		}
	}

	command := strings.Join(append([]string{e.binary}, args...), " ")
	cmd := exec.CommandContext(ctx, e.binary, args...)
	var stdout, stderr limitedBuffer
	stdout.limit = e.outputLimit
	stderr.limit = e.outputLimit
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := ExecResult{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}

	if stderr.Len() > 0 && e.warningObserver != nil {
		e.mu.Lock()

		now := e.clock()
		allowed := !e.hasLastWarning || now.Sub(e.lastWarning) >= e.warningInterval

		if allowed {
			e.lastWarning = now
			e.hasLastWarning = true
		}

		e.mu.Unlock()

		if allowed {
			e.warningObserver(command, result.Stderr)
		}
	}

	if stdout.exceeded || stderr.exceeded {
		return result, fmt.Errorf("%w: %s", ErrOutputLimit, command)
	}

	if err != nil {
		detail := strings.TrimSpace(string(result.Stderr))

		if detail == "" {
			return result, fmt.Errorf("rrd: command %s failed: %w", command, err)
		}

		return result, fmt.Errorf("rrd: command %s failed: %w: %s", command, err, detail)
	}

	return result, nil
}

type limitedBuffer struct {
	data     []byte
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		b.exceeded = true

		return len(p), nil
	}

	remaining := b.limit - len(b.data)

	if remaining <= 0 {
		b.exceeded = true

		return len(p), nil
	}

	if len(p) > remaining {
		b.data = append(b.data, p[:remaining]...)
		b.exceeded = true

		return len(p), nil
	}

	b.data = append(b.data, p...)

	return len(p), nil
}

func (b *limitedBuffer) Bytes() []byte {
	return b.data
}

func (b *limitedBuffer) Len() int {
	return len(b.data)
}
