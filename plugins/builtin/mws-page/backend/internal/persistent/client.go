package persistent

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"

	"mndw.local/rcisock"
)

const maxRecentTargetDiagnostics = 64
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
	Now              Clock
}

type Client struct {
	config Config
	now    Clock

	mu       sync.Mutex
	diag     *diagnosticsRecorder
	store    *targetStore
	dispatch *dispatcher
}

type sessionState struct {
	misses     int
	live       bool
	lastSeenAt time.Time
	power2G    PowerState
	power5G    PowerState
}

func (state sessionState) visible() bool {
	return state.live || state.misses >= 2
}

func New(config Config) *Client {
	if config.Now == nil {
		config.Now = wallClockUTC
	}

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

	client := &Client{
		config: config,
		now:    config.Now,
	}
	client.diag = newDiagnosticsRecorder(&client.mu, config.Now, Diagnostics{
		Configured:           config.Path != "",
		PluginIDPresent:      config.PluginID != "",
		TelemetryPollEnabled: config.TelemetryPoll != nil,
		SocketPath:           config.Path,
		PollInterval:         config.PollInterval.String(),
		IOTimeout:            config.IOTimeout.String(),
		SessionRetention:     config.SessionRetention.String(),
	})
	client.store = newTargetStore(&client.mu, config.Now, client.diag, config.SessionRetention)
	client.dispatch = newDispatcher(&client.mu, config.MaxInflight, client.store, config.IOTimeout)

	return client
}

func (c *Client) HasTarget(identity string) bool {
	if c == nil || identity == "" {
		return false
	}

	return c.store.has(identity)
}

func (c *Client) Send(ctx context.Context, nodeID string, request Request) (Response, error) {
	if c == nil {
		return Response{}, ErrNoSession
	}

	return c.dispatch.send(ctx, nodeID, request)
}

func (c *Client) Diagnostics() Diagnostics {
	c.mu.Lock()

	defer c.mu.Unlock()

	return c.diag.snapshotLocked()
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
	return c.store.snapshot()
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

	defer c.dispatch.clearRPC(rpc)

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

	c.dispatch.setRPC(rpc)
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
	return c.store.updateTargets(targets)
}

func (c *Client) pollTargets(ctx context.Context, rpc *rcisock.Client) error {
	targets := c.store.identities()

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

			response, err := c.dispatch.call(ctx, rpc, target.Identity, Request{Method: "GET", Path: "rci/show/version"})
			if err != nil {
				c.recordTargetError(target, rcisock.ResponseFrame{Status: response.Status, Body: response.Body}, err)
				recordConnectionError(err)
			} else if response.Status != 200 {
				c.recordTargetError(target, rcisock.ResponseFrame{Status: response.Status, Body: response.Body}, nil)
			}

			c.applyResult(target, rcisock.ResponseFrame{Status: response.Status, Body: response.Body}, err)
			c.recordSessionCount()

			if err == nil && response.Status == 200 {
				requester := rpcRequester{dispatch: c.dispatch, rpc: rpc, target: target.Identity}

				if c.config.TelemetryPoll != nil {
					if err := c.config.TelemetryPoll(ctx, target, requester); err != nil {
						diagnostic := DiagnosticError{
							Phase: "telemetry", Identity: target.Identity, Code: "telemetry-failed",
							Message: "telemetry polling failed", At: c.now(),
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

	return connectionErr
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

func (c *Client) applyResult(target Target, response rcisock.ResponseFrame, err error) {
	c.store.applyResult(target, response, err)
}

func (c *Client) clear(reasons ...string) {
	reason := "connection-reset"

	if len(reasons) > 0 && reasons[0] != "" {
		reason = reasons[0]
	}

	c.store.clear(reason)
}

func (c *Client) markDisconnected(reason string) {
	c.store.markDisconnected(reason)
}

func (c *Client) recordConnectionAttempt() {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordConnectionAttemptLocked()
}

func (c *Client) recordConnected() {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordConnectedLocked()
}

func (c *Client) recordDisconnected(reason string) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordDisconnectedLocked(reason)
}

func (c *Client) recordTargets() {
	c.mu.Lock()

	defer c.mu.Unlock()

	targetCount, sessionCount := c.store.countsLocked()

	c.diag.recordTargetsLocked(targetCount, sessionCount)
}

func (c *Client) recordSessionCount() {
	c.mu.Lock()

	defer c.mu.Unlock()

	_, sessionCount := c.store.countsLocked()

	c.diag.recordSessionCountLocked(sessionCount)
}

func (c *Client) recordTelemetrySuccess() {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordTelemetrySuccessLocked()
}

func (c *Client) recordTargetTelemetrySuccess(target Target) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordTargetTelemetrySuccessLocked(target.Identity)
}

func (c *Client) recordTargetTelemetryError(target Target, diagnostic DiagnosticError) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordTargetTelemetryErrorLocked(target.Identity, diagnostic)
}

// RecordTelemetryPhase records one persistent telemetry request without exposing response bodies or transport errors.
func (c *Client) RecordTelemetryPhase(identity, phase string, status int, err error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordTelemetryPhaseLocked(identity, phase, status, err)
}

func (c *Client) recordTargetError(target Target, response rcisock.ResponseFrame, err error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordTargetErrorLocked(target.Identity, response.Status, err)
}

func (c *Client) recordError(diagnostic DiagnosticError) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.diag.recordErrorLocked(diagnostic)
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
