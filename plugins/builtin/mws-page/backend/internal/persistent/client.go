package persistent

import (
	"context"
	"errors"
	"net"
	"sort"
	"sync"
	"time"

	"mndw.local/rcisock"
	"mndw.local/shared/chansem"
	"mndw.local/shared/ptr"
)

const defaultSessionRetention = 3 * time.Minute

var ErrNoSession = errors.New("persistent RCI session unavailable")

type Target struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	MAC      string `json:"mac"`
}

type Session struct {
	Identity string     `json:"-"`
	Mac      string     `json:"mac"`
	Live     bool       `json:"live"`
	Power2G  PowerState `json:"power2g"`
	Power5G  PowerState `json:"power5g"`
}

type Request struct {
	Method string
	Path   string
	Body   []byte
}

type Response struct {
	Status int
	Body   []byte
}

type Requester interface {
	Do(context.Context, Request) (Response, error)
}

type TelemetryPoll func(context.Context, Target, Requester) error

type Config struct {
	Path             string
	PluginID         string
	PollInterval     time.Duration
	RetryDelay       time.Duration
	IOTimeout        time.Duration
	SessionRetention time.Duration
	MaxInflight      int
	Dial             func(context.Context) (net.Conn, error)
	TelemetryPoll    TelemetryPoll
}

type Client struct {
	config Config

	mu                sync.Mutex
	rpc               *rcisock.Client
	inflight          chan struct{}
	targetLocks       map[string]chan struct{}
	targets           map[string]Target
	sessions          map[string]sessionState
	targetDiagnostics map[string]TargetDiagnostics
	diagnostics       Diagnostics
}

type sessionState struct {
	target     Target
	misses     int
	live       bool
	lastSeenAt time.Time
	power2G    PowerState
	power5G    PowerState
}

func New(config Config) *Client {
	if config.PollInterval <= 0 {
		config.PollInterval = 30 * time.Second
	}

	if config.RetryDelay <= 0 {
		config.RetryDelay = time.Second
	}

	if config.IOTimeout <= 0 {
		config.IOTimeout = 5 * time.Second
	}

	if config.SessionRetention <= 0 {
		config.SessionRetention = defaultSessionRetention
	}

	if config.MaxInflight <= 0 {
		config.MaxInflight = 8
	}

	return &Client{
		config:            config,
		inflight:          make(chan struct{}, config.MaxInflight),
		targetLocks:       make(map[string]chan struct{}),
		targets:           make(map[string]Target),
		sessions:          make(map[string]sessionState),
		targetDiagnostics: make(map[string]TargetDiagnostics),
		diagnostics: Diagnostics{
			Configured:           config.Path != "",
			PluginIDPresent:      config.PluginID != "",
			TelemetryPollEnabled: config.TelemetryPoll != nil,
			SocketPath:           config.Path,
			PollInterval:         config.PollInterval.String(),
			IOTimeout:            config.IOTimeout.String(),
			SessionRetention:     config.SessionRetention.String(),
		},
	}
}

func (c *Client) HasTarget(identity string) bool {
	if c == nil || identity == "" {
		return false
	}

	c.mu.Lock()

	defer c.mu.Unlock()

	_, ok := c.targets[identity]

	return ok
}

func (c *Client) Send(ctx context.Context, nodeID string, request Request) (Response, error) {
	if c == nil {
		return Response{}, ErrNoSession
	}

	c.mu.Lock()

	rpc := c.rpc
	_, known := c.targetLocks[nodeID]
	_, present := c.targets[nodeID]

	c.mu.Unlock()

	if !known || !present || rpc == nil {
		return Response{}, ErrNoSession
	}

	callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.config.IOTimeout)

	defer cancel()

	return c.call(callContext, rpc, nodeID, request)
}

func (c *Client) Diagnostics() Diagnostics {
	c.mu.Lock()

	defer c.mu.Unlock()

	diagnostics := cloneDiagnostics(c.diagnostics)
	diagnostics.Targets = make([]TargetDiagnostics, 0, len(c.targetDiagnostics))

	for _, target := range c.targetDiagnostics {
		diagnostics.Targets = append(diagnostics.Targets, cloneTargetDiagnostics(target))
	}

	sortTargetDiagnostics(diagnostics.Targets)

	return diagnostics
}

func (c *Client) Run(ctx context.Context) {
	if c == nil || c.config.PluginID == "" {
		if c != nil {
			c.recordError(DiagnosticError{Phase: "configuration", Code: "plugin-id-missing", Message: "plugin identity unavailable"})
		}

		return
	}

	for {
		if ctx.Err() != nil {
			c.clear()

			return
		}

		if err := c.runConnection(ctx); err != nil && ctx.Err() == nil {
			c.wait(ctx, c.config.RetryDelay)
		}
	}
}

func (c *Client) Snapshot() []Session {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.expireStaleSessionsLocked(time.Now().UTC())

	result := make([]Session, 0, len(c.sessions))

	for _, state := range c.sessions {
		if !visibleSession(state) {
			continue
		}

		result = append(result, Session{Identity: state.target.Identity, Mac: state.target.MAC, Live: state.live, Power2G: state.power2G, Power5G: state.power5G})
	}

	sort.Slice(result, func(i, j int) bool { return result[i].Mac < result[j].Mac })

	return result
}

func (c *Client) runConnection(ctx context.Context) error {
	c.recordConnectionAttempt()

	connection, err := c.dial(ctx)
	if err != nil {
		if ctx.Err() == nil {
			c.recordError(DiagnosticError{Phase: "connection", Code: "socket-unavailable", Message: "persistent session socket unavailable"})
		}

		c.recordDisconnected("dial-failed")

		return err
	}

	rpc := rcisock.NewClient(
		connection,
		rcisock.WithIOTimeout(c.config.IOTimeout),
		rcisock.WithHandshakeTimeout(c.config.IOTimeout),
	)

	defer rpc.Close()

	defer c.clearRPC(rpc)

	var runErr error

	defer func() {
		c.markDisconnected("connection-reset")

		reason := "connection-closed"

		if ctx.Err() != nil {
			reason = "context-canceled"
		} else if runErr != nil {
			reason = "connection-error"
		}

		c.recordDisconnected(reason)
	}()

	if err := rpc.Handshake(ctx, rcisock.ClientHello{PluginID: c.config.PluginID, Proto: rcisock.ProtocolVersion}); err != nil {
		if ctx.Err() == nil {
			c.recordError(DiagnosticError{Phase: "handshake", Code: "handshake-failed", Message: "persistent session handshake failed"})
		}

		runErr = err

		return err
	}

	c.setRPC(rpc)
	c.recordConnected()

	for {
		frame, err := rpc.Call(ctx, rcisock.RequestFrame{Op: "targets"})
		if err != nil {
			if ctx.Err() == nil {
				c.recordError(DiagnosticError{Phase: "targets", Code: "targets-request-failed", Message: "target enumeration request failed"})
			}

			runErr = err

			return err
		}

		if err := c.updateTargets(convertTargets(frame.Targets)); err != nil {
			c.recordError(DiagnosticError{Phase: "targets", Code: "invalid-targets", Message: "target enumeration response invalid"})

			runErr = err

			return err
		}

		c.recordTargets()

		if err := c.pollTargets(ctx, rpc); err != nil {
			runErr = err

			return err
		}

		if err := c.wait(ctx, c.config.PollInterval); err != nil {
			runErr = err

			return err
		}
	}
}

func (c *Client) dial(ctx context.Context) (net.Conn, error) {
	if c.config.Dial != nil {
		return c.config.Dial(ctx)
	}

	if c.config.Path == "" {
		return nil, errors.New("persistent session socket disabled")
	}

	return (&net.Dialer{Timeout: c.config.IOTimeout}).DialContext(ctx, "unix", c.config.Path)
}

func convertTargets(targets []rcisock.Target) []Target {
	converted := make([]Target, len(targets))

	for index, target := range targets {
		converted[index] = Target{Identity: target.Identity, Name: target.Name, MAC: target.MAC}
	}

	return converted
}

func (c *Client) updateTargets(targets []Target) error {
	current := make(map[string]Target, len(targets))

	for _, target := range targets {
		if target.Identity == "" {
			return errors.New("persistent session target has no identity")
		}

		target.MAC = normalizeMAC(target.MAC)

		if target.MAC == "" {
			continue
		}

		current[target.Identity] = target
	}

	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	var added, removed []string

	for identity := range c.targets {
		if _, ok := current[identity]; !ok {
			delete(c.sessions, identity)
			c.markTargetGoneLocked(identity, "target-removed", now)

			removed = append(removed, identity)
		}
	}

	for identity, target := range current {
		if _, exists := c.targetLocks[identity]; !exists {
			c.targetLocks[identity] = make(chan struct{}, 1)
		}

		diagnostic, known := c.targetDiagnostics[identity]
		wasPresent := known && diagnostic.Present

		if !known {
			diagnostic = TargetDiagnostics{Identity: identity, FirstSeenAt: ptr.To(now)}
		}

		diagnostic.Identity = identity
		diagnostic.Name = target.Name
		diagnostic.MAC = target.MAC
		diagnostic.Present = true
		diagnostic.LastSeenAt = ptr.To(now)
		diagnostic.RemovedAt = nil

		if !wasPresent {
			added = append(added, identity)
			diagnostic.SessionReason = "target-added"
			diagnostic.LastSessionChangeAt = ptr.To(now)
		}

		state, ok := c.sessions[identity]

		if !ok {
			state = sessionState{}
			diagnostic.SessionPresent = true
			diagnostic.Live = false
			diagnostic.Misses = 0

			if wasPresent {
				diagnostic.SessionReason = "session-created"
				diagnostic.LastSessionChangeAt = ptr.To(now)
			}
		}

		state.target = target
		state.lastSeenAt = now
		c.sessions[identity] = state
		diagnostic.SessionPresent = true
		diagnostic.Misses = state.misses
		diagnostic.Live = state.live
		c.targetDiagnostics[identity] = diagnostic
	}

	c.targets = current

	if len(added) > 0 || len(removed) > 0 {
		c.recordTargetChangeLocked("enumeration", added, removed, now)
	}

	c.pruneTargetDiagnosticsLocked()

	return nil
}

func (c *Client) pollTargets(ctx context.Context, rpc *rcisock.Client) error {
	c.mu.Lock()

	targets := make([]Target, 0, len(c.targets))

	for _, target := range c.targets {
		targets = append(targets, target)
	}

	c.mu.Unlock()

	var workers sync.WaitGroup
	connectionErrors := make(chan error, 1)
	recordConnectionError := func(err error) {
		if !isConnectionFailure(err) {
			return
		}

		select {
		case connectionErrors <- err:
		default:
		}
	}

	for _, target := range targets {
		target := target

		workers.Add(1)

		go func() {
			defer workers.Done()

			response, err := c.call(ctx, rpc, target.Identity, Request{Method: "GET", Path: "rci/show/version"})
			if err != nil {
				c.recordTargetError(target, rcisock.ResponseFrame{Status: response.Status, Body: response.Body}, err)
				recordConnectionError(err)
			} else if response.Status != 200 {
				c.recordTargetError(target, rcisock.ResponseFrame{Status: response.Status, Body: response.Body}, nil)
			}

			c.applyResult(target, rcisock.ResponseFrame{Status: response.Status, Body: response.Body}, err)
			c.recordSessionCount()

			if err == nil && response.Status == 200 {
				requester := rpcRequester{client: c, rpc: rpc, target: target.Identity}

				if c.config.TelemetryPoll != nil {
					if err := c.config.TelemetryPoll(ctx, target, requester); err != nil {
						diagnostic := DiagnosticError{
							Phase: "telemetry", Identity: target.Identity, Code: "telemetry-failed",
							Message: "telemetry polling failed", At: time.Now().UTC(),
						}

						c.recordTargetTelemetryError(target, diagnostic)
						c.recordError(diagnostic)
						recordConnectionError(err)
					} else {
						c.recordTargetTelemetrySuccess(target)
						c.recordTelemetrySuccess()
					}
				}

				c.pollInterfacePower(ctx, requester, target)
			}
		}()
	}

	workers.Wait()

	select {
	case err := <-connectionErrors:
		return err
	default:
		return nil
	}
}

func isConnectionFailure(err error) bool {
	if err == nil {
		return false
	}

	var remote *rcisock.RemoteError

	if errors.As(err, &remote) {
		return false
	}

	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, rcisock.ErrClosed)
}

type rpcRequester struct {
	client *Client
	rpc    *rcisock.Client
	target string
}

func (r rpcRequester) Do(ctx context.Context, request Request) (Response, error) {
	return r.client.call(ctx, r.rpc, r.target, request)
}

func (c *Client) call(ctx context.Context, rpc *rcisock.Client, nodeID string, request Request) (Response, error) {
	c.mu.Lock()

	targetLock := c.targetLocks[nodeID]

	c.mu.Unlock()

	if targetLock == nil || rpc == nil {
		return Response{}, ErrNoSession
	}

	if err := chansem.Acquire(ctx, c.inflight); err != nil {
		return Response{}, err
	}

	defer chansem.Release(c.inflight)

	if err := chansem.Acquire(ctx, targetLock); err != nil {
		return Response{}, err
	}

	defer chansem.Release(targetLock)

	frame, err := rpc.Call(ctx, rcisock.RequestFrame{
		Target: nodeID, Method: request.Method, Path: request.Path, Body: request.Body,
	})
	if err != nil {
		return Response{}, err
	}

	return Response{Status: frame.Status, Body: append([]byte(nil), frame.Body...)}, nil
}

func (c *Client) setRPC(rpc *rcisock.Client) {
	c.mu.Lock()

	c.rpc = rpc

	c.mu.Unlock()
}

func (c *Client) clearRPC(rpc *rcisock.Client) {
	c.mu.Lock()

	if c.rpc == rpc {
		c.rpc = nil
	}

	c.mu.Unlock()
}

func (c *Client) applyResult(target Target, response rcisock.ResponseFrame, err error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	state, ok := c.sessions[target.Identity]

	if !ok {
		return
	}

	diagnostic := c.targetDiagnostics[target.Identity]
	now := time.Now().UTC()
	diagnostic.LastProbeAt = ptr.To(now)

	if response.Status != 0 {
		status := response.Status
		diagnostic.LastProbeStatus = &status
	} else {
		diagnostic.LastProbeStatus = nil
	}

	if err == nil && response.Status == 200 {
		state.misses = 0
		state.live = true
		c.sessions[target.Identity] = state
		diagnostic.LastProbeError = nil
		diagnostic.SessionPresent = true
		diagnostic.Live = true
		diagnostic.Misses = 0
		diagnostic.SessionReason = "probe-success"
		diagnostic.LastSessionChangeAt = ptr.To(now)
		c.targetDiagnostics[target.Identity] = diagnostic

		return
	}

	diagnostic.LastProbeError = persistentDiagnosticError(
		target.Identity,
		response.Status,
		err,
		now,
		targetDiagnosticMessages,
	)
	var remote *rcisock.RemoteError

	if errors.As(err, &remote) && (remote.Code == "no-session-for-target" || remote.Code == "unsupported-firmware" || remote.Code == "not-permitted") {
		delete(c.sessions, target.Identity)

		diagnostic.SessionPresent = false
		diagnostic.Live = false
		diagnostic.Misses = 0
		diagnostic.SessionReason = "evicted:" + remote.Code
		diagnostic.LastSessionChangeAt = ptr.To(now)
		c.targetDiagnostics[target.Identity] = diagnostic

		return
	}

	if errors.As(err, &remote) && remote.Code != "session-invalid" && remote.Code != "target-unreachable" {
		c.targetDiagnostics[target.Identity] = diagnostic

		return
	}

	state.misses++

	if state.misses >= 2 {
		state.live = false
	}

	c.sessions[target.Identity] = state
	diagnostic.SessionPresent = true
	diagnostic.Live = state.live
	diagnostic.Misses = state.misses
	diagnostic.SessionReason = "probe-miss"
	diagnostic.LastSessionChangeAt = ptr.To(now)
	c.targetDiagnostics[target.Identity] = diagnostic
}

func (c *Client) clear(reasons ...string) {
	reason := "connection-reset"

	if len(reasons) > 0 && reasons[0] != "" {
		reason = reasons[0]
	}

	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	var removed []string

	for identity := range c.targets {
		c.markTargetGoneLocked(identity, reason, now)

		removed = append(removed, identity)
	}

	if len(removed) > 0 {
		c.recordTargetChangeLocked(reason, nil, removed, now)
	}

	c.targets = make(map[string]Target)
	c.targetLocks = make(map[string]chan struct{})
	c.sessions = make(map[string]sessionState)
	c.diagnostics.TargetCount = 0
	c.diagnostics.SessionCount = 0

	c.pruneTargetDiagnosticsLocked()
}

func (c *Client) markDisconnected(reason string) {
	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	for identity, state := range c.sessions {
		state.live = false

		if state.misses < 2 {
			state.misses = 2
		}

		c.sessions[identity] = state
		diagnostic := c.targetDiagnostics[identity]
		diagnostic.Present = true
		diagnostic.SessionPresent = true
		diagnostic.Live = false
		diagnostic.Misses = state.misses
		diagnostic.SessionReason = reason
		diagnostic.RemovedAt = nil
		diagnostic.LastSessionChangeAt = ptr.To(now)
		c.targetDiagnostics[identity] = diagnostic
	}

	c.diagnostics.TargetCount = len(c.targets)
	c.diagnostics.SessionCount = c.sessionCountLocked()
}

func (c *Client) expireStaleSessionsLocked(now time.Time) {
	for identity, state := range c.sessions {
		if state.lastSeenAt.IsZero() || now.Sub(state.lastSeenAt) <= c.config.SessionRetention {
			continue
		}

		delete(c.sessions, identity)
		delete(c.targets, identity)
		c.markTargetGoneLocked(identity, "retention-expired", now)
	}

	c.diagnostics.TargetCount = len(c.targets)
	c.diagnostics.SessionCount = c.sessionCountLocked()

	c.pruneTargetDiagnosticsLocked()
}

func (c *Client) recordConnectionAttempt() {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diagnostics.ConnectionAttempts++
}

func (c *Client) recordConnected() {
	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	if c.diagnostics.LastConnectedAt != nil {
		c.diagnostics.ReconnectCount++
	}

	c.diagnostics.Connected = true
	c.diagnostics.LastConnectedAt = ptr.To(now)
}

func (c *Client) recordDisconnected(reason string) {
	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	c.diagnostics.Connected = false
	c.diagnostics.LastDisconnectedAt = ptr.To(now)
	c.diagnostics.LastDisconnectReason = reason
}

func (c *Client) recordTargets() {
	c.mu.Lock()

	defer c.mu.Unlock()

	now := time.Now().UTC()
	c.diagnostics.TargetCount = len(c.targets)
	c.diagnostics.TargetEnumerations++
	c.diagnostics.SessionCount = c.sessionCountLocked()
	c.diagnostics.LastTargetsAt = ptr.To(now)
}

func (c *Client) recordSessionCount() {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diagnostics.SessionCount = c.sessionCountLocked()
}

func (c *Client) recordTelemetrySuccess() {
	c.mu.Lock()

	defer c.mu.Unlock()

	now := time.Now().UTC()
	c.diagnostics.LastTelemetryAt = ptr.To(now)
}

func (c *Client) recordTargetTelemetrySuccess(target Target) {
	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	diagnostic := c.targetDiagnostics[target.Identity]
	diagnostic.LastTelemetryAt = ptr.To(now)
	diagnostic.LastTelemetryError = nil
	c.targetDiagnostics[target.Identity] = diagnostic
}

func (c *Client) recordTargetTelemetryError(target Target, diagnostic DiagnosticError) {
	now := time.Now().UTC()
	diagnostic.At = now

	c.mu.Lock()

	defer c.mu.Unlock()

	targetDiagnostic := c.targetDiagnostics[target.Identity]
	targetDiagnostic.LastTelemetryError = cloneDiagnosticError(&diagnostic)
	c.targetDiagnostics[target.Identity] = targetDiagnostic
}

// RecordTelemetryPhase records one persistent telemetry request without exposing response bodies or transport errors.
func (c *Client) RecordTelemetryPhase(identity, phase string, status int, err error) {
	now := time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	diagnostic := c.targetDiagnostics[identity]

	if diagnostic.Identity == "" {
		diagnostic.Identity = identity
		diagnostic.FirstSeenAt = ptr.To(now)
		diagnostic.Present = true
		diagnostic.SessionPresent = true
	}

	phaseDiagnostic := telemetryPhase(&diagnostic.Telemetry, phase)

	if phaseDiagnostic == nil {
		return
	}

	phaseDiagnostic.LastAttemptAt = ptr.To(now)

	if err == nil && status == 200 {
		phaseDiagnostic.LastSuccessAt = ptr.To(now)
	} else {
		phaseDiagnostic.LastError = persistentDiagnosticError(
			identity,
			status,
			err,
			now,
			newTelemetryDiagnosticMessages(phase),
		)
	}

	c.targetDiagnostics[identity] = diagnostic
}

func (c *Client) recordTargetError(target Target, response rcisock.ResponseFrame, err error) {
	diagnostic := persistentDiagnosticError(
		target.Identity,
		response.Status,
		err,
		time.Now().UTC(),
		targetDiagnosticMessages,
	)

	c.recordError(*diagnostic)
}

func (c *Client) recordError(diagnostic DiagnosticError) {
	diagnostic.At = time.Now().UTC()

	c.mu.Lock()

	defer c.mu.Unlock()

	c.diagnostics.LastError = &diagnostic
}

func (c *Client) sessionCountLocked() int {
	count := 0

	for _, state := range c.sessions {
		if visibleSession(state) {
			count++
		}
	}

	return count
}

func visibleSession(state sessionState) bool {
	return state.live || state.misses >= 2
}

func (c *Client) recordTargetChangeLocked(reason string, added, removed []string, at time.Time) {
	sort.Strings(added)
	sort.Strings(removed)

	c.diagnostics.LastTargetChange = &TargetChange{At: at, Reason: reason, Added: append([]string(nil), added...), Removed: append([]string(nil), removed...)}
}

// markTargetGoneLocked flips a target's diagnostics to fully absent. The caller
// must hold c.mu.
func (c *Client) markTargetGoneLocked(identity, reason string, now time.Time) {
	state := c.targetDiagnostics[identity]
	state.Present = false
	state.SessionPresent = false
	state.Live = false
	state.SessionReason = reason
	state.LastSessionChangeAt = ptr.To(now)
	state.RemovedAt = ptr.To(now)
	c.targetDiagnostics[identity] = state
}

func (c *Client) pruneTargetDiagnosticsLocked() {
	removed := make([]TargetDiagnostics, 0, len(c.targetDiagnostics))

	for _, diagnostic := range c.targetDiagnostics {
		if !diagnostic.Present {
			removed = append(removed, diagnostic)
		}
	}

	if len(removed) <= maxRecentTargetDiagnostics {
		return
	}

	sort.Slice(removed, func(i, j int) bool {
		return diagnosticTime(removed[i].RemovedAt).Before(diagnosticTime(removed[j].RemovedAt))
	})

	for _, diagnostic := range removed[:len(removed)-maxRecentTargetDiagnostics] {
		delete(c.targetDiagnostics, diagnostic.Identity)
	}
}

type diagnosticMessages struct {
	phase          string
	failureMessage string
	timeoutMessage string
	statusMessage  string
}

var targetDiagnosticMessages = diagnosticMessages{
	phase:          "target-probe",
	failureMessage: "target probe failed",
	timeoutMessage: "target probe timed out",
	statusMessage:  "target probe returned unexpected status",
}

func newTelemetryDiagnosticMessages(phase string) diagnosticMessages {
	return diagnosticMessages{
		phase:          "telemetry:" + phase,
		failureMessage: "telemetry request failed",
		timeoutMessage: "telemetry request timed out",
		statusMessage:  "telemetry request returned unexpected status",
	}
}

func persistentDiagnosticError(
	identity string,
	status int,
	err error,
	at time.Time,
	messages diagnosticMessages,
) *DiagnosticError {
	diagnostic := &DiagnosticError{Phase: messages.phase, Identity: identity, Status: status, At: at}
	var remote *rcisock.RemoteError

	if errors.As(err, &remote) {
		diagnostic.Code = remote.Code
		diagnostic.Message = remote.Code

		return diagnostic
	}

	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			diagnostic.Code = "request-timeout"
			diagnostic.Message = messages.timeoutMessage

			return diagnostic
		}

		if errors.Is(err, rcisock.ErrClosed) {
			diagnostic.Code = "socket-closed"
			diagnostic.Message = "persistent session socket closed"

			return diagnostic
		}

		diagnostic.Code = "probe-failed"
		diagnostic.Message = messages.failureMessage

		if messages.phase != "target-probe" {
			diagnostic.Code = "request-failed"
		}

		return diagnostic
	}

	diagnostic.Code = "unexpected-status"
	diagnostic.Message = messages.statusMessage

	return diagnostic
}

func telemetryPhase(diagnostics *TelemetryDiagnostics, phase string) *TelemetryPhaseDiagnostics {
	switch phase {
	case "system":
		return &diagnostics.System
	case "cpuRrd":
		return &diagnostics.CPURRD
	case "memoryRrd":
		return &diagnostics.MemoryRRD
	default:
		return nil
	}
}

func (c *Client) wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)

	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func normalizeMAC(value string) string {
	address, err := net.ParseMAC(value)
	if err != nil || len(address) != 6 {
		return ""
	}

	return address.String()
}
