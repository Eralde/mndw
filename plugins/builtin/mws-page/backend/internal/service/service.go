package service

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	rci "mndw.local/rci"
	"mws-page/internal/clock"
	"mws-page/internal/config"
	"mws-page/internal/persistent"
	"mws-page/internal/telemetry"
)

type Service struct {
	telemetry  *telemetry.Collector
	persistent PersistentSource
	clock      clock.Clock
}

type PersistentSource interface {
	Run(context.Context)
	Snapshot() []persistent.Session
	Diagnostics() persistent.Diagnostics
}

type PersistentWriter interface {
	PersistentSource
	Send(context.Context, string, persistent.Request) (persistent.Response, error)
	HasTarget(string) bool
}

type persistentTelemetryRecorder interface {
	RecordTelemetryPhase(identity, phase string, status int, err error)
}

type OperationError struct {
	status  int
	code    string
	message string
	err     error
}

func (e *OperationError) Error() string { return e.message }
func (e *OperationError) Unwrap() error { return e.err }
func (e *OperationError) Status() int   { return e.status }
func (e *OperationError) Code() string  { return e.code }

func New(cfg config.Config) *Service {
	service := &Service{
		telemetry: telemetry.NewCollector(),
		clock:     clock.Real(),
	}

	if persistentPath := os.Getenv("MNDW_RCI_SESSION_SOCKET"); persistentPath != "" {
		client := persistent.New(persistent.Config{
			Path:          persistentPath,
			PluginID:      os.Getenv("MNDW_PLUGIN_ID"),
			PollInterval:  5 * time.Second,
			IOTimeout:     cfg.IOTimeout,
			TelemetryPoll: service.pollPersistentTelemetry,
		})
		service.persistent = client
	}

	return service
}

func (s *Service) Run(ctx context.Context) {
	if s.persistent != nil {
		s.persistent.Run(ctx)
	}
}

// DiagnosticsSnapshot returns local service state without credentials or token material.
func (s *Service) DiagnosticsSnapshot() map[string]any {
	return map[string]any{
		"lastRefreshAt":      s.lastPersistentTargetsAt(),
		"persistent":         s.persistentDiagnosticsSnapshot(),
		"persistentSessions": s.diagnosticsPersistentSessionsSnapshot(),
	}
}

func (s *Service) SetClock(c clock.Clock) {
	if c == nil {
		return
	}

	s.clock = c
}

func (s *Service) Nodes(_ context.Context) (any, error) {
	return telemetry.NodesResponse{
		LastRefreshAt:       s.lastPersistentTargetsAt(),
		PersistentAvailable: s.persistent != nil,
		PersistentSessions:  s.persistentSessionsSnapshot(),
	}, nil
}

func (s *Service) SetPersistentSource(source PersistentSource) {
	s.persistent = source
}

func (s *Service) pollPersistentTelemetry(ctx context.Context, target persistent.Target, requester persistent.Requester) error {
	phases := []string{"system", "cpuRrd", "memoryRrd"}
	queries := []rci.Query{
		rci.Q("show.system"),
		{Path: "show.system.rrd.cpu", Data: map[string]any{"detail": 0, "attribute": "avg"}},
		{Path: "show.system.rrd.memory", Data: map[string]any{"detail": 0, "attribute": "used"}},
	}
	var reply persistent.Response
	var transportErr error
	send := rci.TransportFunc(func(requestCtx context.Context, body []byte) (rci.Response, error) {
		reply, transportErr = requester.Do(requestCtx, persistent.Request{Method: http.MethodPost, Path: "rci/", Body: body})

		return rci.Response{Status: reply.Status, Body: reply.Body}, transportErr
	})
	client, err := rci.New(send)
	if err != nil {
		return err
	}

	responses, clientErr := client.ExecuteMany(ctx, queries...)

	for _, phase := range phases {
		s.recordPersistentTelemetryPhase(target.Identity, phase, reply.Status, transportErr)
	}

	if clientErr != nil {
		return clientErr
	}

	for index, response := range responses {
		if response == nil {
			return fmt.Errorf("persistent %s telemetry response empty", phases[index])
		}
	}

	sample, err := telemetry.ParsePersistentTelemetry(responses[0], responses[1], responses[2], s.clock.Now().UTC())
	if err != nil {
		s.recordPersistentTelemetryPhase(target.Identity, "system", http.StatusOK, err)

		return err
	}

	s.telemetry.StorePersistent(target.Identity, sample)

	return nil
}

func (s *Service) recordPersistentTelemetryPhase(identity, phase string, status int, err error) {
	recorder, ok := s.persistent.(persistentTelemetryRecorder)

	if !ok {
		return
	}

	recorder.RecordTelemetryPhase(identity, phase, status, err)
}

func (s *Service) lastPersistentTargetsAt() *time.Time {
	if s.persistent == nil {
		return nil
	}

	return s.persistent.Diagnostics().LastTargetsAt
}

func (s *Service) persistentSessionsSnapshot() []telemetry.PersistentSession {
	if s.persistent == nil {
		return []telemetry.PersistentSession{}
	}

	sessions := s.persistent.Snapshot()
	result := make([]telemetry.PersistentSession, 0, len(sessions))
	now := s.clock.Now()

	for _, session := range sessions {
		item := telemetry.PersistentSession{
			Mac:     session.Mac,
			Live:    session.Live,
			Power2G: telemetry.PersistentRadioPower{Value: session.Power2G.Value, Available: session.Power2G.Available},
			Power5G: telemetry.PersistentRadioPower{Value: session.Power5G.Value, Available: session.Power5G.Available},
		}

		if sessionData, ok := s.telemetry.Persistent(session.Identity, now); ok {
			item.Telemetry = &sessionData
		}

		result = append(result, item)
	}

	return result
}

func (s *Service) persistentDiagnosticsSnapshot() persistent.Diagnostics {
	if s.persistent == nil {
		return persistent.Diagnostics{}
	}

	return s.persistent.Diagnostics()
}

const diagnosticsMaxRRDTicks = 60

func (s *Service) diagnosticsPersistentSessionsSnapshot() []telemetry.PersistentSession {
	sessions := s.persistentSessionsSnapshot()

	for index := range sessions {
		if sessions[index].Telemetry == nil {
			continue
		}

		sessions[index].Telemetry.CPURRD.Data = newestRRDTicks(sessions[index].Telemetry.CPURRD.Data)
		sessions[index].Telemetry.MemoryRRD.Data = newestRRDTicks(sessions[index].Telemetry.MemoryRRD.Data)
	}

	return sessions
}

func newestRRDTicks(ticks []telemetry.RrdTick) []telemetry.RrdTick {
	if len(ticks) <= diagnosticsMaxRRDTicks {
		return ticks
	}

	result := make([]telemetry.RrdTick, diagnosticsMaxRRDTicks)

	copy(result, ticks[len(ticks)-diagnosticsMaxRRDTicks:])

	return result
}

func validNodeID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}

	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != ':' && char != '-' && char != '_' && char != '.' {
			return false
		}
	}

	return true
}
