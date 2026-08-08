package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"mndw.local/device-auth"
	rci "mndw.local/rci"
	"mws-page/internal/clock"
	"mws-page/internal/config"
	"mws-page/internal/credentials"
	"mws-page/internal/discovery"
	"mws-page/internal/persistent"
	"mws-page/internal/session"
	"mws-page/internal/target"
	"mws-page/internal/telemetry"
)

type Service struct {
	transport     *auth.HTTPTransport
	authenticator *auth.Authenticator
	credentials   *credentials.Store
	epoch         *credentials.Epoch
	holder        *session.Holder
	controller    auth.Target
	mu            sync.Mutex
	members       []discovery.Member
	refreshMu     sync.Mutex
	telemetry     *telemetry.Collector
	persistent    PersistentSource
	clock         clock.Clock
	lastRefreshAt time.Time
	lastError     *diagnosticError
}

type PersistentSource interface {
	Run(context.Context)
	Snapshot() []persistent.Session
	Diagnostics() persistent.Diagnostics
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

type diagnosticError struct {
	Operation string `json:"operation"`
	Status    int    `json:"status"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	At        string `json:"at"`
}

func (e *OperationError) Error() string { return e.message }
func (e *OperationError) Unwrap() error { return e.err }
func (e *OperationError) Status() int   { return e.status }
func (e *OperationError) Code() string  { return e.code }

func New(cfg config.Config) *Service {
	transport := auth.NewHTTPTransport(nil)
	transport.IOTimeout = cfg.IOTimeout
	transport.MaxResponseBytes = cfg.MaxResponseBytes
	authenticator := auth.New(auth.Options{Transport: transport, AuthTimeout: cfg.AuthOperation})
	store := credentials.NewStore()
	epoch := credentials.NewEpoch()
	holder := session.NewHolder(authenticator, store)
	service := &Service{
		transport:     transport,
		authenticator: authenticator,
		credentials:   store,
		epoch:         epoch,
		holder:        holder,
		controller:    auth.Target{BaseURL: cfg.ControllerURL},
		telemetry:     telemetry.NewCollector(holder, epoch, telemetry.FieldAdapter{}),
		clock:         clock.Real(),
	}
	if persistentPath := os.Getenv("MNDW_RCI_SESSION_SOCKET"); persistentPath != "" {
		service.persistent = persistent.New(persistent.Config{
			Path:          persistentPath,
			PluginID:      os.Getenv("MNDW_PLUGIN_ID"),
			PollInterval:  5 * time.Second,
			IOTimeout:     cfg.IOTimeout,
			TelemetryPoll: service.pollPersistentTelemetry,
		})
	}
	return service
}

func (s *Service) Run(ctx context.Context) {
	if s.persistent != nil {
		go s.persistent.Run(ctx)
	}
	refreshTicker := time.NewTicker(30 * time.Second)
	defer refreshTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-refreshTicker.C:
			if s.credentials.State() == credentials.StatePresent {
				_ = s.refresh(ctx)
			}
		}
	}
}

// WriteDiagnostics remains a harmless source-compatible no-op. Diagnostics are
// served on demand over the bounded service HTTP endpoint; no file is written.
func (s *Service) WriteDiagnostics() error { return nil }

func (s *Service) writeDiagnosticsTick() error { return nil }

// DiagnosticsSnapshot returns local service state without credentials or token material.
func (s *Service) DiagnosticsSnapshot() map[string]any {
	return map[string]any{
		"credState":          string(s.credentials.State()),
		"lastRefreshAt":      s.lastRefreshSnapshot(),
		"lastError":          s.lastErrorSnapshot(),
		"nodes":              s.nodesSnapshot(),
		"persistent":         s.persistentDiagnosticsSnapshot(),
		"persistentSessions": s.diagnosticsPersistentSessionsSnapshot(),
	}
}

func (s *Service) SetClock(c clock.Clock) {
	if c == nil {
		return
	}
	s.clock = c
	s.holder.SetClock(c)
}

func (s *Service) Credentials(ctx context.Context, username, password string) (any, error) {
	if username == "" || password == "" {
		return nil, s.recordError("credentials", &OperationError{status: 401, code: "authentication_failed", message: "authentication failed"})
	}
	token, operationCtx := s.epoch.Begin(ctx)
	s.holder.Forget()
	s.credentials.Set(username, []byte(password), token)
	if err := s.holder.Authenticate(operationCtx, "controller", s.controller); err != nil {
		return nil, s.recordError("credentials", err)
	}
	if err := s.refresh(operationCtx); err != nil {
		return nil, s.recordError("credentials", err)
	}
	return map[string]any{"authenticated": true, "nodes": len(s.membersSnapshot())}, nil
}

func (s *Service) Forget(ctx context.Context) (any, error) {
	_, operationCtx := s.epoch.Begin(ctx)
	s.holder.Forget()
	s.credentials.Forget(s.epoch.Current())
	s.clearError()
	select {
	case <-operationCtx.Done():
		return nil, operationCtx.Err()
	default:
		return map[string]bool{"forgotten": true}, nil
	}
}

func (s *Service) Nodes(ctx context.Context) (any, error) {
	state := s.credentials.State()
	if len(s.membersSnapshot()) == 0 && state == credentials.StatePresent {
		if err := s.refresh(ctx); err != nil {
			return nil, s.recordError("nodes", err)
		}
	}
	return telemetry.NodesResponse{CredState: string(state), LastRefreshAt: s.lastRefreshSnapshot(), Nodes: s.nodesSnapshot(), PersistentSessions: s.persistentSessionsSnapshot()}, nil
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

func (s *Service) Snapshot(ctx context.Context, nodeID string) (any, error) {
	if s.credentials.State() != credentials.StatePresent {
		return nil, &OperationError{status: 409, code: "credentials_required", message: "credentials required"}
	}
	if len(s.membersSnapshot()) == 0 {
		if err := s.refresh(ctx); err != nil {
			return nil, classify(err)
		}
	}
	nodes := s.nodesSnapshot()
	if nodeID == "" {
		return map[string]any{"credState": s.credentials.State(), "nodes": nodes}, nil
	}
	if !validNodeID(nodeID) {
		return nil, &OperationError{status: 400, code: "operation_rejected", message: "invalid node id"}
	}
	for _, node := range nodes {
		if node.ID == nodeID {
			return map[string]any{"credState": s.credentials.State(), "node": node}, nil
		}
	}
	return nil, &OperationError{status: 409, code: "node_offline", message: "node unavailable"}
}

func (s *Service) refresh(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	data, err := s.query(ctx, "controller", s.controller, "show.mws.member")
	if err != nil {
		s.recordError("refresh", err)
		return err
	}
	members, err := discovery.ParseMembers(data)
	if err != nil {
		s.recordError("refresh", err)
		return err
	}
	s.mu.Lock()
	previous := make(map[string]discovery.Member, len(s.members))
	for _, member := range s.members {
		previous[member.Identity()] = member
	}
	s.mu.Unlock()
	for index := range members {
		identity := members[index].Identity()
		resolved, resolveErr := target.Resolve(members[index])
		if resolveErr != nil {
			members[index].Online = false
			s.holder.State().SetOffline(identity, s.clock.Now())
			continue
		}
		if old, ok := previous[identity]; ok && (!old.Online || old.IP != members[index].IP) {
			s.holder.State().SetOnline(identity, s.clock.Now())
		}
		if !s.holder.CanAttempt(identity, s.clock.Now()) {
			continue
		}
		if err := s.holder.Authenticate(ctx, identity, resolved.AuthTarget()); err != nil {
			continue
		}
		members[index].Online = true
	}
	current := make(map[string]struct{}, len(members))
	for _, member := range members {
		current[member.Identity()] = struct{}{}
	}
	for identity, old := range previous {
		if old.Online {
			if _, exists := current[identity]; !exists {
				s.holder.State().SetOffline(identity, s.clock.Now())
			}
		}
	}
	s.mu.Lock()
	s.members = append([]discovery.Member(nil), members...)
	s.lastRefreshAt = s.clock.Now().UTC()
	s.lastError = nil
	s.mu.Unlock()
	return nil
}

func (s *Service) query(ctx context.Context, id string, destination auth.Target, path string) ([]byte, error) {
	var response []byte
	operation := func(operationCtx context.Context, jar http.CookieJar) error {
		client, err := rci.New(s.authTransport(destination, jar))
		if err != nil {
			return err
		}
		response, err = client.Execute(operationCtx, rci.Q(path))
		return err
	}
	if err := s.holder.WithSession(ctx, id, destination, operation); err != nil {
		return nil, err
	}
	return response, nil
}

func (s *Service) authTransport(destination auth.Target, jar http.CookieJar) rci.TransportFunc {
	return func(ctx context.Context, body []byte) (rci.Response, error) {
		reply, err := s.transport.Do(ctx, destination, jar, http.MethodPost, "/rci/", body)
		return rci.Response{Status: reply.Status, Body: reply.Body}, err
	}
}

func (s *Service) membersSnapshot() []discovery.Member {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]discovery.Member(nil), s.members...)
}

func (s *Service) recordError(operation string, err error) *OperationError {
	classified := operationError(err)
	next := diagnosticError{
		Operation: operation,
		Status:    classified.Status(),
		Code:      classified.Code(),
		Message:   classified.Error(),
		At:        s.clock.Now().UTC().Format(time.RFC3339Nano),
	}
	s.mu.Lock()
	changed := s.lastError == nil
	if !changed {
		changed = s.lastError.Operation != next.Operation ||
			s.lastError.Status != next.Status ||
			s.lastError.Code != next.Code ||
			s.lastError.Message != next.Message
	}
	s.lastError = &next
	s.mu.Unlock()
	return classified
}

func (s *Service) clearError() {
	s.mu.Lock()
	s.lastError = nil
	s.mu.Unlock()
}

func (s *Service) lastErrorSnapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastError == nil {
		return nil
	}

	return map[string]any{
		"operation": s.lastError.Operation,
		"status":    s.lastError.Status,
		"code":      s.lastError.Code,
		"message":   s.lastError.Message,
		"at":        s.lastError.At,
	}
}

func (s *Service) nodesSnapshot() []telemetry.Node {
	members := s.membersSnapshot()
	result := make([]telemetry.Node, 0, len(members))
	for _, member := range members {
		state := "node_offline"
		if member.Online {
			state = "authenticating"
		}
		var lastSuccessAt *time.Time
		if snapshot, ok := s.holder.State().Snapshot(member.Identity()); ok {
			switch snapshot.State {
			case session.NodeOnline:
				state = "live"
			case session.NodeFailed:
				state = "failed"
			case session.NodeOffline:
				if member.Online {
					state = "reauthenticating"
				}
			}
			if !snapshot.LastSuccess.IsZero() {
				lastSuccess := snapshot.LastSuccess.UTC()
				lastSuccessAt = &lastSuccess
			}
		}
		result = append(result, telemetry.Node{
			ID: member.Identity(), CID: member.CID, MAC: member.MAC, Name: member.Name,
			IP: member.IP, Online: member.Online, State: state,
			LastConnectedNode: member.LastPeer, LastSuccessAt: lastSuccessAt,
		})
	}
	return result
}

func (s *Service) lastRefreshSnapshot() *time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastRefreshAt.IsZero() {
		return nil
	}
	lastRefresh := s.lastRefreshAt.UTC()
	return &lastRefresh
}

func (s *Service) persistentSessionsSnapshot() []telemetry.PersistentSession {
	if s.persistent == nil {
		return nil
	}
	sessions := s.persistent.Snapshot()
	result := make([]telemetry.PersistentSession, 0, len(sessions))
	now := s.clock.Now()
	for _, session := range sessions {
		item := telemetry.PersistentSession{Mac: session.Mac, Live: session.Live, Stale: !session.Live}
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

func classify(err error) error {
	var authErr *auth.AuthError
	if errors.As(err, &authErr) {
		switch authErr.Kind {
		case auth.ErrorRejected:
			return &OperationError{status: 401, code: "authentication_failed", message: "authentication failed", err: err}
		case auth.ErrorUnsupported:
			return &OperationError{status: 422, code: "unsupported_firmware", message: "unsupported firmware", err: err}
		case auth.ErrorTimeout, auth.ErrorTransport:
			return &OperationError{status: 504, code: "target_unavailable", message: "target unavailable", err: err}
		default:
			return &OperationError{status: 400, code: "operation_rejected", message: "operation rejected", err: err}
		}
	}
	if strings.Contains(err.Error(), "credentials required") {
		return &OperationError{status: 409, code: "credentials_required", message: "credentials required", err: err}
	}
	return &OperationError{status: 504, code: "target_unavailable", message: "target unavailable", err: err}
}

func operationError(err error) *OperationError {
	var classified *OperationError
	if errors.As(err, &classified) {
		return classified
	}
	classifiedError := classify(err)
	if errors.As(classifiedError, &classified) {
		return classified
	}
	return &OperationError{status: 500, code: "operation_rejected", message: "operation rejected", err: err}
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
