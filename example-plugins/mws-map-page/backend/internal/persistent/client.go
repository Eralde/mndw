package persistent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const protocolVersion = 1
const maxRecentTargetDiagnostics = 64
const defaultSessionRetention = 3 * time.Minute

type Target struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	MAC      string `json:"mac"`
}

type Session struct {
	Identity string `json:"-"`
	Mac      string `json:"mac"`
	Live     bool   `json:"live"`
}

type Diagnostics struct {
	Configured           bool                `json:"configured"`
	PluginIDPresent      bool                `json:"pluginIdPresent"`
	TelemetryPollEnabled bool                `json:"telemetryPollEnabled"`
	SocketPath           string              `json:"socketPath"`
	PollInterval         string              `json:"pollInterval"`
	IOTimeout            string              `json:"ioTimeout"`
	SessionRetention     string              `json:"sessionRetention"`
	Connected            bool                `json:"connected"`
	ConnectionAttempts   int                 `json:"connectionAttempts"`
	ReconnectCount       int                 `json:"reconnectCount"`
	LastConnectedAt      *time.Time          `json:"lastConnectedAt"`
	LastDisconnectedAt   *time.Time          `json:"lastDisconnectedAt"`
	LastDisconnectReason string              `json:"lastDisconnectReason,omitempty"`
	TargetCount          int                 `json:"targetCount"`
	TargetEnumerations   int                 `json:"targetEnumerations"`
	SessionCount         int                 `json:"sessionCount"`
	LastTargetsAt        *time.Time          `json:"lastTargetsAt"`
	LastTargetChange     *TargetChange       `json:"lastTargetChange"`
	LastTelemetryAt      *time.Time          `json:"lastTelemetryAt"`
	LastError            *DiagnosticError    `json:"lastError"`
	Targets              []TargetDiagnostics `json:"targets"`
}

type TargetChange struct {
	At      time.Time `json:"at"`
	Reason  string    `json:"reason"`
	Added   []string  `json:"added,omitempty"`
	Removed []string  `json:"removed,omitempty"`
}

type TargetDiagnostics struct {
	Identity            string               `json:"identity"`
	Name                string               `json:"name,omitempty"`
	MAC                 string               `json:"mac,omitempty"`
	Present             bool                 `json:"present"`
	SessionPresent      bool                 `json:"sessionPresent"`
	Live                bool                 `json:"live"`
	Misses              int                  `json:"misses"`
	SessionReason       string               `json:"sessionReason,omitempty"`
	FirstSeenAt         *time.Time           `json:"firstSeenAt"`
	LastSeenAt          *time.Time           `json:"lastSeenAt"`
	RemovedAt           *time.Time           `json:"removedAt"`
	LastProbeAt         *time.Time           `json:"lastProbeAt"`
	LastProbeStatus     *int                 `json:"lastProbeStatus"`
	LastProbeError      *DiagnosticError     `json:"lastProbeError"`
	LastTelemetryAt     *time.Time           `json:"lastTelemetryAt"`
	LastTelemetryError  *DiagnosticError     `json:"lastTelemetryError"`
	Telemetry           TelemetryDiagnostics `json:"telemetry"`
	LastSessionChangeAt *time.Time           `json:"lastSessionChangeAt"`
}

type TelemetryDiagnostics struct {
	System    TelemetryPhaseDiagnostics `json:"system"`
	CPURRD    TelemetryPhaseDiagnostics `json:"cpuRrd"`
	MemoryRRD TelemetryPhaseDiagnostics `json:"memoryRrd"`
}

type TelemetryPhaseDiagnostics struct {
	LastAttemptAt *time.Time       `json:"lastAttemptAt"`
	LastSuccessAt *time.Time       `json:"lastSuccessAt"`
	LastError     *DiagnosticError `json:"lastError"`
}

type DiagnosticError struct {
	Phase    string    `json:"phase"`
	Identity string    `json:"identity,omitempty"`
	Code     string    `json:"code"`
	Message  string    `json:"message"`
	Status   int       `json:"status,omitempty"`
	At       time.Time `json:"at"`
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
}

type wireFrame struct {
	Hello   *wireHello      `json:"hello,omitempty"`
	ID      int64           `json:"id,omitempty"`
	Op      string          `json:"op,omitempty"`
	Target  string          `json:"target,omitempty"`
	Method  string          `json:"method,omitempty"`
	Path    string          `json:"path,omitempty"`
	Status  int             `json:"status,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Targets []Target        `json:"targets,omitempty"`
	Error   *wireError      `json:"error,omitempty"`
}

type wireHello struct {
	PluginID string `json:"pluginId,omitempty"`
	Proto    int    `json:"proto"`
	OK       bool   `json:"ok,omitempty"`
}

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type remoteError struct {
	code string
}

func (e *remoteError) Error() string { return e.code }

var errPersistentSocketClosed = errors.New("persistent session socket closed")

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

func (c *Client) Diagnostics() Diagnostics {
	c.mu.Lock()
	defer c.mu.Unlock()
	diagnostics := cloneDiagnostics(c.diagnostics)
	diagnostics.Targets = make([]TargetDiagnostics, 0, len(c.targetDiagnostics))
	for _, target := range c.targetDiagnostics {
		diagnostics.Targets = append(diagnostics.Targets, cloneTargetDiagnostics(target))
	}
	sort.Slice(diagnostics.Targets, func(i, j int) bool {
		return diagnostics.Targets[i].Identity < diagnostics.Targets[j].Identity
	})
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
		if !state.live {
			continue
		}
		result = append(result, Session{Identity: state.target.Identity, Mac: state.target.MAC, Live: true})
	}
	for _, state := range c.sessions {
		if state.live || state.misses < 2 {
			continue
		}
		result = append(result, Session{Identity: state.target.Identity, Mac: state.target.MAC, Live: false})
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
	defer connection.Close()
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
	if err := c.handshake(connection); err != nil {
		if ctx.Err() == nil {
			c.recordError(DiagnosticError{Phase: "handshake", Code: "handshake-failed", Message: "persistent session handshake failed"})
		}
		runErr = err
		return err
	}
	c.recordConnected()
	rpc := newRPC(connection, c.config.IOTimeout)
	defer rpc.close()

	for {
		frame, err := rpc.call(ctx, wireFrame{Op: "targets"})
		if err != nil {
			if ctx.Err() == nil {
				c.recordError(DiagnosticError{Phase: "targets", Code: "targets-request-failed", Message: "target enumeration request failed"})
			}
			runErr = err
			return err
		}
		if err := c.updateTargets(frame.Targets); err != nil {
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

func (c *Client) handshake(connection net.Conn) error {
	if err := connection.SetDeadline(time.Now().Add(c.config.IOTimeout)); err != nil {
		return err
	}
	if err := writeFrame(connection, wireFrame{Hello: &wireHello{PluginID: c.config.PluginID, Proto: protocolVersion}}); err != nil {
		return err
	}
	var response wireFrame
	if err := json.NewDecoder(bufio.NewReader(connection)).Decode(&response); err != nil {
		return err
	}
	if response.Hello == nil || response.Hello.Proto != protocolVersion || !response.Hello.OK {
		return errors.New("persistent session hello rejected")
	}
	return connection.SetDeadline(time.Time{})
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
			state := c.targetDiagnostics[identity]
			state.Present = false
			state.SessionPresent = false
			state.Live = false
			state.SessionReason = "target-removed"
			state.LastSessionChangeAt = timePointer(now)
			state.RemovedAt = timePointer(now)
			c.targetDiagnostics[identity] = state
			removed = append(removed, identity)
		}
	}
	for identity, target := range current {
		diagnostic, known := c.targetDiagnostics[identity]
		wasPresent := known && diagnostic.Present
		if !known {
			diagnostic = TargetDiagnostics{Identity: identity, FirstSeenAt: timePointer(now)}
		}
		diagnostic.Identity = identity
		diagnostic.Name = target.Name
		diagnostic.MAC = target.MAC
		diagnostic.Present = true
		diagnostic.LastSeenAt = timePointer(now)
		diagnostic.RemovedAt = nil
		if !wasPresent {
			added = append(added, identity)
			diagnostic.SessionReason = "target-added"
			diagnostic.LastSessionChangeAt = timePointer(now)
		}
		state, ok := c.sessions[identity]
		if !ok {
			state = sessionState{}
			diagnostic.SessionPresent = true
			diagnostic.Live = false
			diagnostic.Misses = 0
			if wasPresent {
				diagnostic.SessionReason = "session-created"
				diagnostic.LastSessionChangeAt = timePointer(now)
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

func (c *Client) pollTargets(ctx context.Context, rpc *rpcConnection) error {
	c.mu.Lock()
	targets := make([]Target, 0, len(c.targets))
	for _, target := range c.targets {
		targets = append(targets, target)
	}
	c.mu.Unlock()
	semaphore := make(chan struct{}, c.config.MaxInflight)
	var workers sync.WaitGroup
	var errorMu sync.Mutex
	var connectionErr error
	recordConnectionError := func(err error) {
		if !isConnectionFailure(err) {
			return
		}
		errorMu.Lock()
		defer errorMu.Unlock()
		if connectionErr == nil {
			connectionErr = err
		}
	}
	for _, target := range targets {
		target := target
		workers.Add(1)
		go func() {
			defer workers.Done()
			select {
			case semaphore <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-semaphore }()
			response, err := rpc.call(ctx, wireFrame{Target: target.Identity, Method: "GET", Path: "rci/show/version"})
			if err != nil {
				c.recordTargetError(target, response, err)
				recordConnectionError(err)
			} else if response.Status != 200 {
				c.recordTargetError(target, response, nil)
			}
			c.applyResult(target, response, err)
			c.recordSessionCount()
			if err == nil && response.Status == 200 && c.config.TelemetryPoll != nil {
				if err := c.config.TelemetryPoll(ctx, target, rpcRequester{rpc: rpc, target: target.Identity}); err != nil {
					diagnostic := DiagnosticError{Phase: "telemetry", Identity: target.Identity, Code: "telemetry-failed", Message: "telemetry polling failed"}
					c.recordTargetTelemetryError(target, diagnostic)
					c.recordError(diagnostic)
					recordConnectionError(err)
				} else {
					c.recordTargetTelemetrySuccess(target)
					c.recordTelemetrySuccess()
				}
			}
		}()
	}
	workers.Wait()
	return connectionErr
}

func isConnectionFailure(err error) bool {
	if err == nil {
		return false
	}
	var remote *remoteError
	if errors.As(err, &remote) {
		return false
	}
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errPersistentSocketClosed)
}

type rpcRequester struct {
	rpc    *rpcConnection
	target string
}

func (r rpcRequester) Do(ctx context.Context, request Request) (Response, error) {
	frame, err := r.rpc.call(ctx, wireFrame{Target: r.target, Method: request.Method, Path: request.Path, Body: request.Body})
	if err != nil {
		return Response{}, err
	}
	return Response{Status: frame.Status, Body: append([]byte(nil), frame.Body...)}, nil
}

func (c *Client) applyResult(target Target, response wireFrame, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state, ok := c.sessions[target.Identity]
	if !ok {
		return
	}
	diagnostic := c.targetDiagnostics[target.Identity]
	now := time.Now().UTC()
	diagnostic.LastProbeAt = timePointer(now)
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
		diagnostic.LastSessionChangeAt = timePointer(now)
		c.targetDiagnostics[target.Identity] = diagnostic
		return
	}
	diagnostic.LastProbeError = targetProbeError(target, response, err, now)
	var remote *remoteError
	if errors.As(err, &remote) && (remote.code == "no-session-for-target" || remote.code == "unsupported-firmware" || remote.code == "not-permitted") {
		delete(c.sessions, target.Identity)
		diagnostic.SessionPresent = false
		diagnostic.Live = false
		diagnostic.Misses = 0
		diagnostic.SessionReason = "evicted:" + remote.code
		diagnostic.LastSessionChangeAt = timePointer(now)
		c.targetDiagnostics[target.Identity] = diagnostic
		return
	}
	if errors.As(err, &remote) && remote.code != "session-invalid" && remote.code != "target-unreachable" {
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
	diagnostic.LastSessionChangeAt = timePointer(now)
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
		state := c.targetDiagnostics[identity]
		state.Present = false
		state.SessionPresent = false
		state.Live = false
		state.SessionReason = reason
		state.LastSessionChangeAt = timePointer(now)
		state.RemovedAt = timePointer(now)
		c.targetDiagnostics[identity] = state
		removed = append(removed, identity)
	}
	if len(removed) > 0 {
		c.recordTargetChangeLocked(reason, nil, removed, now)
	}
	c.targets = make(map[string]Target)
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
		diagnostic.LastSessionChangeAt = timePointer(now)
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
		diagnostic := c.targetDiagnostics[identity]
		diagnostic.Present = false
		diagnostic.SessionPresent = false
		diagnostic.Live = false
		diagnostic.SessionReason = "retention-expired"
		diagnostic.RemovedAt = timePointer(now)
		diagnostic.LastSessionChangeAt = timePointer(now)
		c.targetDiagnostics[identity] = diagnostic
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
	c.diagnostics.LastConnectedAt = timePointer(now)
}

func (c *Client) recordDisconnected(reason string) {
	now := time.Now().UTC()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.diagnostics.Connected = false
	c.diagnostics.LastDisconnectedAt = timePointer(now)
	c.diagnostics.LastDisconnectReason = reason
}

func (c *Client) recordTargets() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now().UTC()
	c.diagnostics.TargetCount = len(c.targets)
	c.diagnostics.TargetEnumerations++
	c.diagnostics.SessionCount = c.sessionCountLocked()
	c.diagnostics.LastTargetsAt = timePointer(now)
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
	c.diagnostics.LastTelemetryAt = timePointer(now)
}

func (c *Client) recordTargetTelemetrySuccess(target Target) {
	now := time.Now().UTC()
	c.mu.Lock()
	defer c.mu.Unlock()
	diagnostic := c.targetDiagnostics[target.Identity]
	diagnostic.LastTelemetryAt = timePointer(now)
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
		diagnostic.FirstSeenAt = timePointer(now)
		diagnostic.Present = true
		diagnostic.SessionPresent = true
	}
	phaseDiagnostic := telemetryPhase(&diagnostic.Telemetry, phase)
	if phaseDiagnostic == nil {
		return
	}
	phaseDiagnostic.LastAttemptAt = timePointer(now)
	if err == nil && status == 200 {
		phaseDiagnostic.LastSuccessAt = timePointer(now)
	} else {
		phaseDiagnostic.LastError = telemetryDiagnosticError(identity, phase, status, err, now)
	}
	c.targetDiagnostics[identity] = diagnostic
}

func (c *Client) recordTargetError(target Target, response wireFrame, err error) {
	diagnostic := targetProbeError(target, response, err, time.Now().UTC())
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
		if state.live || state.misses >= 2 {
			count++
		}
	}
	return count
}

func (c *Client) recordTargetChangeLocked(reason string, added, removed []string, at time.Time) {
	sort.Strings(added)
	sort.Strings(removed)
	c.diagnostics.LastTargetChange = &TargetChange{At: at, Reason: reason, Added: append([]string(nil), added...), Removed: append([]string(nil), removed...)}
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

func (c *Client) targetDiagnosticLocked(identity string) TargetDiagnostics {
	diagnostic := c.targetDiagnostics[identity]
	if diagnostic.Identity == "" {
		diagnostic.Identity = identity
		diagnostic.FirstSeenAt = timePointer(time.Now().UTC())
	}
	return diagnostic
}

func targetProbeError(target Target, response wireFrame, err error, at time.Time) *DiagnosticError {
	diagnostic := &DiagnosticError{Phase: "target-probe", Identity: target.Identity, Status: response.Status, At: at}
	var remote *remoteError
	if errors.As(err, &remote) {
		diagnostic.Code = remote.code
		diagnostic.Message = remote.code
		return diagnostic
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			diagnostic.Code = "request-timeout"
			diagnostic.Message = "target probe timed out"
			return diagnostic
		}
		if errors.Is(err, errPersistentSocketClosed) {
			diagnostic.Code = "socket-closed"
			diagnostic.Message = "persistent session socket closed"
			return diagnostic
		}
		diagnostic.Code = "probe-failed"
		diagnostic.Message = "target probe failed"
		return diagnostic
	}
	diagnostic.Code = "unexpected-status"
	diagnostic.Message = "target probe returned unexpected status"
	return diagnostic
}

func telemetryDiagnosticError(identity, phase string, status int, err error, at time.Time) *DiagnosticError {
	diagnostic := &DiagnosticError{Phase: "telemetry:" + phase, Identity: identity, Status: status, At: at}
	var remote *remoteError
	if errors.As(err, &remote) {
		diagnostic.Code = remote.code
		diagnostic.Message = remote.code
		return diagnostic
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			diagnostic.Code = "request-timeout"
			diagnostic.Message = "telemetry request timed out"
			return diagnostic
		}
		if errors.Is(err, errPersistentSocketClosed) {
			diagnostic.Code = "socket-closed"
			diagnostic.Message = "persistent session socket closed"
			return diagnostic
		}
		diagnostic.Code = "request-failed"
		diagnostic.Message = "telemetry request failed"
		return diagnostic
	}
	diagnostic.Code = "unexpected-status"
	diagnostic.Message = "telemetry request returned unexpected status"
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

func cloneDiagnostics(diagnostics Diagnostics) Diagnostics {
	clone := diagnostics
	clone.LastConnectedAt = cloneTime(diagnostics.LastConnectedAt)
	clone.LastDisconnectedAt = cloneTime(diagnostics.LastDisconnectedAt)
	clone.LastTargetsAt = cloneTime(diagnostics.LastTargetsAt)
	clone.LastTelemetryAt = cloneTime(diagnostics.LastTelemetryAt)
	clone.LastError = cloneDiagnosticError(diagnostics.LastError)
	if diagnostics.LastTargetChange != nil {
		change := *diagnostics.LastTargetChange
		change.Added = append([]string(nil), diagnostics.LastTargetChange.Added...)
		change.Removed = append([]string(nil), diagnostics.LastTargetChange.Removed...)
		clone.LastTargetChange = &change
	}
	clone.Targets = nil
	return clone
}

func cloneTargetDiagnostics(diagnostic TargetDiagnostics) TargetDiagnostics {
	clone := diagnostic
	clone.FirstSeenAt = cloneTime(diagnostic.FirstSeenAt)
	clone.LastSeenAt = cloneTime(diagnostic.LastSeenAt)
	clone.RemovedAt = cloneTime(diagnostic.RemovedAt)
	clone.LastProbeAt = cloneTime(diagnostic.LastProbeAt)
	clone.LastProbeStatus = cloneInt(diagnostic.LastProbeStatus)
	clone.LastProbeError = cloneDiagnosticError(diagnostic.LastProbeError)
	clone.LastTelemetryAt = cloneTime(diagnostic.LastTelemetryAt)
	clone.LastTelemetryError = cloneDiagnosticError(diagnostic.LastTelemetryError)
	clone.LastSessionChangeAt = cloneTime(diagnostic.LastSessionChangeAt)
	clone.Telemetry = cloneTelemetryDiagnostics(diagnostic.Telemetry)
	return clone
}

func cloneTelemetryDiagnostics(diagnostics TelemetryDiagnostics) TelemetryDiagnostics {
	return TelemetryDiagnostics{
		System:    cloneTelemetryPhaseDiagnostics(diagnostics.System),
		CPURRD:    cloneTelemetryPhaseDiagnostics(diagnostics.CPURRD),
		MemoryRRD: cloneTelemetryPhaseDiagnostics(diagnostics.MemoryRRD),
	}
}

func cloneTelemetryPhaseDiagnostics(diagnostics TelemetryPhaseDiagnostics) TelemetryPhaseDiagnostics {
	return TelemetryPhaseDiagnostics{
		LastAttemptAt: cloneTime(diagnostics.LastAttemptAt),
		LastSuccessAt: cloneTime(diagnostics.LastSuccessAt),
		LastError:     cloneDiagnosticError(diagnostics.LastError),
	}
}

func cloneDiagnosticError(diagnostic *DiagnosticError) *DiagnosticError {
	if diagnostic == nil {
		return nil
	}
	clone := *diagnostic
	return &clone
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func timePointer(value time.Time) *time.Time {
	clone := value
	return &clone
}

func diagnosticTime(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
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

func writeFrame(connection net.Conn, frame wireFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	_, err = connection.Write(append(data, '\n'))
	return err
}

type rpcConnection struct {
	connection net.Conn
	ioTimeout  time.Duration
	nextID     atomic.Int64
	writeMu    sync.Mutex
	pendingMu  sync.Mutex
	pending    map[int64]chan wireFrame
	done       chan struct{}
	closeOnce  sync.Once
}

func newRPC(connection net.Conn, ioTimeout time.Duration) *rpcConnection {
	if ioTimeout <= 0 {
		ioTimeout = 5 * time.Second
	}
	rpc := &rpcConnection{connection: connection, ioTimeout: ioTimeout, pending: make(map[int64]chan wireFrame), done: make(chan struct{})}
	go rpc.readLoop()
	return rpc
}

func (r *rpcConnection) call(ctx context.Context, request wireFrame) (wireFrame, error) {
	requestContext, cancel := context.WithTimeout(ctx, r.ioTimeout)
	defer cancel()
	id := r.nextID.Add(1)
	request.ID = id
	response := make(chan wireFrame, 1)
	r.pendingMu.Lock()
	r.pending[id] = response
	r.pendingMu.Unlock()
	r.writeMu.Lock()
	err := writeFrame(r.connection, request)
	r.writeMu.Unlock()
	if err != nil {
		r.removePending(id)
		r.close()
		return wireFrame{}, fmt.Errorf("%w: %v", errPersistentSocketClosed, err)
	}
	select {
	case frame := <-response:
		if frame.Error != nil {
			return frame, &remoteError{code: frame.Error.Code}
		}
		return frame, nil
	case <-requestContext.Done():
		r.removePending(id)
		r.close()
		return wireFrame{}, requestContext.Err()
	case <-r.done:
		r.removePending(id)
		return wireFrame{}, errPersistentSocketClosed
	}
}

func (r *rpcConnection) readLoop() {
	decoder := json.NewDecoder(bufio.NewReader(r.connection))
	for {
		var frame wireFrame
		if err := decoder.Decode(&frame); err != nil {
			r.close()
			return
		}
		r.pendingMu.Lock()
		response, ok := r.pending[frame.ID]
		if ok {
			delete(r.pending, frame.ID)
		}
		r.pendingMu.Unlock()
		if ok {
			response <- frame
		}
	}
}

func (r *rpcConnection) removePending(id int64) {
	r.pendingMu.Lock()
	delete(r.pending, id)
	r.pendingMu.Unlock()
}

func (r *rpcConnection) close() {
	r.closeOnce.Do(func() {
		close(r.done)
		_ = r.connection.Close()
	})
}
