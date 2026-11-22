package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"iperf-widget/internal/iperf"
	"iperf-widget/internal/probe"
)

var (
	ErrBusy         = errors.New("a speed test is already running")
	ErrServerBusy   = errors.New("all iperf3 ports are busy")
	ErrInvalidInput = errors.New("invalid speed test input")
)

const (
	probeSamples  = 10
	probeInterval = 200 * time.Millisecond
	probeTimeout  = 2 * time.Second
)

type Request struct {
	Host     string `json:"host"`
	PortFrom int    `json:"portFrom"`
	PortTo   int    `json:"portTo"`
	Duration int    `json:"duration"`
	Streams  int    `json:"streams"`
}

func (request Request) Validate() error {
	if !validHost(request.Host) {
		return fmt.Errorf("%w: host must be a hostname or IP address", ErrInvalidInput)
	}

	if request.PortFrom < 1 || request.PortFrom > 65535 || request.PortTo < 1 || request.PortTo > 65535 {
		return fmt.Errorf("%w: port must be between 1 and 65535", ErrInvalidInput)
	}

	if request.PortFrom > request.PortTo {
		return fmt.Errorf("%w: port range is reversed", ErrInvalidInput)
	}

	if request.Duration < 5 || request.Duration > 30 {
		return fmt.Errorf("%w: duration must be between 5 and 30 seconds", ErrInvalidInput)
	}

	if request.Streams < 1 || request.Streams > 8 {
		return fmt.Errorf("%w: streams must be between 1 and 8", ErrInvalidInput)
	}

	return nil
}

func validHost(host string) bool {
	if host == "" || len(host) > 253 || strings.TrimSpace(host) != host {
		return false
	}

	if net.ParseIP(host) != nil {
		return true
	}

	name := strings.TrimSuffix(host, ".")

	if name == "" {
		return false
	}

	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}

		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
				(character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}

	return true
}

type Manager struct {
	binary string

	mu         sync.Mutex
	active     bool
	activeDone chan struct{}
}

func NewManager() *Manager {
	binary := strings.TrimSpace(os.Getenv("IPERF3_PATH"))

	if binary == "" {
		binary = "/opt/bin/iperf3"
	}

	return &Manager{binary: binary}
}

func (manager *Manager) Run(ctx context.Context, request Request, send func(any)) error {
	if !manager.acquire() {
		return ErrBusy
	}

	defer manager.release()

	if err := request.Validate(); err != nil {
		return err
	}

	if send == nil {
		send = func(any) {}
	}

	pingPort := request.PortFrom

	for _, phase := range []struct {
		name    string
		reverse bool
	}{
		{name: "download", reverse: true},
		{name: "upload"},
	} {
		completed := false

		for port := request.PortFrom; port <= request.PortTo; port++ {
			if ctx.Err() != nil {
				send(Message{Type: "stopped"})

				return nil
			}

			send(Message{Type: "phase", Phase: phase.name, Port: port})

			var total *float64

			runErr := iperf.Run(ctx, iperf.Options{
				Binary:   manager.binary,
				Host:     request.Host,
				Port:     port,
				Duration: request.Duration,
				Streams:  request.Streams,
				Reverse:  phase.reverse,
			}, func(event iperf.Event) {
				switch event.Kind {
				case iperf.EventInterval:
					send(Message{Type: "interval", Phase: phase.name, Second: event.Second, BitsPerSecond: event.BitsPerSecond})
				case iperf.EventEnd:
					value := event.BitsPerSecond
					total = &value
				}
			})

			if errors.Is(runErr, iperf.ErrBusy) {
				if port < request.PortTo {
					continue
				}

				return ErrServerBusy
			}

			if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) || ctx.Err() != nil {
				send(Message{Type: "stopped"})

				return nil
			}

			if runErr != nil {
				return runErr
			}

			if total == nil {
				return fmt.Errorf("iperf3 %s run returned no receiver total", phase.name)
			}

			send(Message{Type: "result", Phase: phase.name, BitsPerSecond: *total})

			if phase.name == "upload" {
				pingPort = port
			}

			completed = true

			break
		}

		if !completed {
			return ErrServerBusy
		}
	}

	send(Message{Type: "phase", Phase: "ping", Port: pingPort})

	pingMs, jitterMs, err := probe.Measure(ctx, request.Host, pingPort, probeSamples, probeInterval, probeTimeout,
		func(index int, ms float64, ok bool) {
			message := Message{Type: "pingSample", Index: index}

			if ok {
				message.MS = &ms
			}

			send(message)
		})
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		send(Message{Type: "stopped"})

		return nil
	}

	if errors.Is(err, iperf.ErrUnreachable) {
		send(Message{Type: "ping"})
		send(Message{Type: "done"})

		return nil
	}

	if err != nil {
		return err
	}

	send(Message{Type: "ping", PingMs: &pingMs, JitterMs: &jitterMs})

	send(Message{Type: "done"})

	return nil
}

func (manager *Manager) acquire() bool {
	manager.mu.Lock()

	defer manager.mu.Unlock()

	if manager.active {
		return false
	}

	manager.active = true
	manager.activeDone = make(chan struct{})

	return true
}

func (manager *Manager) release() {
	manager.mu.Lock()

	defer manager.mu.Unlock()

	manager.active = false

	close(manager.activeDone)

	manager.activeDone = nil
}

func (manager *Manager) Wait(ctx context.Context) error {
	manager.mu.Lock()

	if !manager.active {
		manager.mu.Unlock()

		return nil
	}

	done := manager.activeDone

	manager.mu.Unlock()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type Message struct {
	Type          string
	Phase         string
	Port          int
	PingMs        *float64
	JitterMs      *float64
	Second        int
	BitsPerSecond float64
	Index         int
	MS            *float64
	Code          string
	Message       string
}

func (message Message) MarshalJSON() ([]byte, error) {
	switch message.Type {
	case "phase":
		return json.Marshal(struct {
			Type  string `json:"type"`
			Phase string `json:"phase"`
			Port  int    `json:"port"`
		}{message.Type, message.Phase, message.Port})
	case "ping":
		return json.Marshal(struct {
			Type     string   `json:"type"`
			PingMs   *float64 `json:"pingMs"`
			JitterMs *float64 `json:"jitterMs"`
		}{message.Type, message.PingMs, message.JitterMs})
	case "pingSample":
		return json.Marshal(struct {
			Type  string   `json:"type"`
			Index int      `json:"index"`
			MS    *float64 `json:"ms"`
		}{message.Type, message.Index, message.MS})
	case "interval":
		return json.Marshal(struct {
			Type          string  `json:"type"`
			Phase         string  `json:"phase"`
			Second        int     `json:"second"`
			BitsPerSecond float64 `json:"bitsPerSecond"`
		}{message.Type, message.Phase, message.Second, message.BitsPerSecond})
	case "result":
		return json.Marshal(struct {
			Type          string  `json:"type"`
			Phase         string  `json:"phase"`
			BitsPerSecond float64 `json:"bitsPerSecond"`
		}{message.Type, message.Phase, message.BitsPerSecond})
	case "error":
		return json.Marshal(struct {
			Type    string `json:"type"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}{message.Type, message.Code, message.Message})
	default:
		return json.Marshal(struct {
			Type string `json:"type"`
		}{message.Type})
	}
}

func MessageForError(err error) Message {
	switch {
	case errors.Is(err, ErrBusy):
		return Message{Type: "error", Code: "busy", Message: "Another speed test is running"}
	case errors.Is(err, ErrServerBusy):
		return Message{Type: "error", Code: "server-busy", Message: "All ports on this iperf3 server are busy"}
	case errors.Is(err, iperf.ErrUnreachable):
		return Message{Type: "error", Code: "unreachable", Message: "The iperf3 server is unreachable"}
	case errors.Is(err, iperf.ErrMissing):
		return Message{Type: "error", Code: "iperf-missing", Message: "iperf3 is not installed"}
	case errors.Is(err, ErrInvalidInput):
		return Message{Type: "error", Code: "invalid-input", Message: err.Error()}
	default:
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, strings.Join(strings.Fields(err.Error()), " "))
		}

		return Message{Type: "error", Code: "iperf-failed", Message: "The speed test failed"}
	}
}
