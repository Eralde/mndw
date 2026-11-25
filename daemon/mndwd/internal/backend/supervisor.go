package backend

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"runtime/debug"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	maxConsecutiveFailures = 5
	healthyServiceDuration = 60 * time.Second
)

type socketCloser interface {
	Close(code websocket.StatusCode, reason string) error
}

func closeSockets(connections []socketCloser) {
	for _, conn := range connections {
		_ = conn.Close(websocket.StatusServiceRestart, "mndw updating")
	}
}

type ServiceSpec struct {
	PluginID         string
	Dir              string
	Command          string
	Args             []string
	ProtocolVersion  int
	RCISessionSocket string
	Builtin          bool
	Enabled          bool
	RemovalPending   bool
}

type lifecycleToken struct {
	run *operationRun
}

// startupTicket and retryState must remain non-zero-sized: their addresses identify one scheduled action.
type startupTicket struct {
	spec ServiceSpec
}

type retryState struct {
	timer *time.Timer
}

// effect is work the caller runs after Supervisor.mu is released.
type effect interface {
	run(*Supervisor)
}

type startupEffect struct {
	spec   ServiceSpec
	ticket *startupTicket
	start  func(ServiceSpec)
}

func (e startupEffect) run(s *Supervisor) {
	go func() {
		defer func() {
			s.mu.Lock()

			if record := s.serviceRecordLocked(e.spec.PluginID); record != nil && record.service.startup == e.ticket {
				record.service.startup = nil
			}

			s.doneStartupLocked()

			s.unlock()
		}()

		e.start(e.spec)
	}()
}

// runEffects runs effects in order and must never be called with Supervisor.mu held.
func (s *Supervisor) runEffects(effects []effect) {
	for _, current := range effects {
		current.run(s)
	}
}

// addStartupLocked, doneStartupLocked, and startupsIdleLocked require Supervisor.mu held.
func (s *Supervisor) addStartupLocked() {
	if s.startups == 0 {
		s.startupsIdle = make(chan struct{})
	}

	s.startups++
}

func (s *Supervisor) doneStartupLocked() {
	if s.startups == 0 {
		panic("startup count underflow")
	}

	s.startups--

	if s.startups == 0 {
		close(s.startupsIdle)

		s.startupsIdle = nil
	}
}

func (s *Supervisor) startupsIdleLocked() <-chan struct{} {
	if s.startups > 0 {
		return s.startupsIdle
	}

	idle := make(chan struct{})

	close(idle)

	return idle
}

type lifecycleOperation struct {
	token              *lifecycleToken
	joined             bool
	conflict           bool
	supersededWorkDone <-chan struct{}
}

type transitionSnapshot struct {
	present    bool
	intent     Intent
	operation  Operation
	generation uint64
}

func (s ServiceSpec) Equal(other ServiceSpec) bool {
	return s.PluginID == other.PluginID &&
		s.Dir == other.Dir &&
		s.Command == other.Command &&
		slices.Equal(s.Args, other.Args) &&
		s.ProtocolVersion == other.ProtocolVersion &&
		s.RCISessionSocket == other.RCISessionSocket &&
		s.Builtin == other.Builtin &&
		s.Enabled == other.Enabled &&
		s.RemovalPending == other.RemovalPending
}

type SupervisorConfig struct {
	RuntimeRoot               string
	PluginDataRoot            string
	AllowSymlinkedBuiltinRoot bool
	Limits                    Limits
	SupportedProtocols        []int
	ReadinessTimeout          time.Duration
	DiagnosticsTimeout        time.Duration
	StopTimeout               time.Duration
	FinalReapTimeout          time.Duration
	Logger                    *slog.Logger
	Now                       func() time.Time
	LifetimeCtx               context.Context
}

type Supervisor struct {
	mu                  sync.Mutex
	cfg                 SupervisorConfig
	admission           *Admission
	reservedServices    int
	plugins             map[string]*pluginRecord
	nextGen             uint64
	nextProcessID       uint64
	lifetimeCtx         context.Context
	now                 func() time.Time
	startDesired        func(ServiceSpec)
	launchServiceFunc   func(ServiceSpec, RuntimePaths, ValidatedCommand) (*exec.Cmd, *StderrRing, error)
	waitProcessFunc     func(*exec.Cmd) error
	beforeRegistration  func()
	platformMaintenance bool
	// retryCallbackDone marks callback completion; retryCallbackStarting marks progress before it locks.
	retryCallbackDone              func(string)
	retryCallbackStarting          func(string)
	startups                       int
	startupsIdle                   chan struct{}
	shuttingDown                   bool
	invariantChecksOff             bool
	invariantCreatedAt             string
	invariantCreatedBy             string
	invariantRecords               []invariantRecord
	invariantFixtureExempt         map[*pluginRecord]map[invariantID]struct{}
	invariantDeclaredFixtureExempt map[string]map[invariantID]string
	invariantSeen                  map[invariantRecordKey]struct{}
	invariantDropped               map[invariantMode]int
}

type serviceState struct {
	spec         ServiceSpec
	paths        RuntimePaths
	status       RuntimeStatus
	recentStderr *StderrRing
	stop         *stopState
	lastStopErr  error
	// pending is a start that waits until the plugin is idle; nil means none.
	pending *startRequest
	// proc is the launch or child process phase; nil means neither exists.
	proc procPhase
	// slot says whether the plugin owns one of the MaxSupervisedServices slots, and who claimed it.
	slot slotState
	// startup and retry identify in-flight startup/retry actions while this service record exists.
	startup *startupTicket
	retry   *retryState
}

// slotState says whether this plugin owns one of the MaxSupervisedServices slots, and who claimed it.
//
// slotReservedByReconcile and slotHeld must stay distinct: Reconcile reserves a slot in admission order before any
// Start; only an unclaimed reservation may be given back by takeUnstartedReservationLocked. The reverted first
// TASK-48 attempt released a slot that an admitted launch had already claimed.
type slotState uint8

const (
	// slotNone means no slot.
	slotNone slotState = iota
	// slotReservedByReconcile means Reconcile took the slot and Start has not claimed it; proc is nil.
	slotReservedByReconcile
	// slotHeld means Start claimed the slot; proc may be nil, launching, started or registered.
	slotHeld
)

func (s slotState) String() string {
	switch s {
	case slotNone:
		return "none"
	case slotReservedByReconcile:
		return "reserved"
	case slotHeld:
		return "held"
	default:
		return fmt.Sprintf("slotState(%d)", uint8(s))
	}
}

// claimSlot turns a reservation into a held slot. A record without a slot stays without one: claiming never
// takes a slot, only acquireServiceSlotLocked does.
func (s *serviceState) claimSlot() {
	if s.slot == slotReservedByReconcile {
		s.slot = slotHeld
	}
}

// unclaimSlot turns a held slot back into an unclaimed reservation, which is what a restart that keeps its slot
// needs: the start that follows claims it again, and a start that never launches gives it back through
// takeUnstartedReservationLocked. A record without a slot stays without one.
func (s *serviceState) unclaimSlot() {
	if s.slot == slotHeld {
		s.slot = slotReservedByReconcile
	}
}

// setReservation marks a held slot as reserved by Reconcile, or as claimed by Start. It requires a slot: on
// slotNone it would create one without counting it in Supervisor.reservedServices.
func (s *serviceState) setReservation(reserved bool) {
	if reserved {
		s.slot = slotReservedByReconcile

		return
	}

	s.slot = slotHeld
}

// procPhase is a sealed sum type: nil means no launch and no process, otherwise exactly one phase.
// A phase value is never mutated; a transition assigns a new value.
type procPhase interface{ procPhase() }

// procLaunching marks a launch that has begun and has no child yet.
type procLaunching struct{ launch *launchIdentity }

// procStarted marks a child that exists but is not registered yet.
type procStarted struct{ process *registeredProcess }

// procRegistered marks a child that the supervisor owns and has registered.
type procRegistered struct{ process *registeredProcess }

func (procLaunching) procPhase()  {}
func (procStarted) procPhase()    {}
func (procRegistered) procPhase() {}

// launching returns the launch in flight, or nil.
func (s *serviceState) launching() *launchIdentity {
	if phase, ok := s.proc.(procLaunching); ok {
		return phase.launch
	}

	return nil
}

// process returns the child process in any phase that has one; it is nil while a launch is still in flight.
func (s *serviceState) process() *registeredProcess {
	switch phase := s.proc.(type) {
	case procStarted:
		return phase.process
	case procRegistered:
		return phase.process
	default:
		return nil
	}
}

// registered reports whether the child process is registered.
func (s *serviceState) registered() bool {
	_, ok := s.proc.(procRegistered)

	return ok
}

// startRequest is never mutated once stored; markPendingStartLocked replaces it as a whole.
type startRequest struct {
	spec ServiceSpec
	// retry marks a start recorded by the retry timer, which needs StateBackoff to still hold when it runs.
	retry bool
	// generation is the transition generation when the request was recorded.
	generation uint64
}

// stopKind says what a stop does to the plugin's status and slot.
type stopKind int

const (
	// stopKeep leaves status and slot alone: the cleanup after a failed start.
	stopKeep stopKind = iota
	// stopRestart resets the status to StateStopped and keeps the slot: a replace, whose restart continues.
	stopRestart
	// stopRelease resets the status and releases the slot when the stop's cleanup is done: disable, remove, an
	// incompatible protocol, StopAll, an unregistered child.
	stopRelease
)

// stopState is never mutated after done is closed; waiters keep the pointer and read err from it. kind only grows
// while the stop runs: a disable that joins a replace stop makes it a release.
type stopState struct {
	done chan struct{}
	err  error
	kind stopKind
}

type transitionState struct {
	intent      Intent
	operation   Operation
	priorIntent Intent
	run         *operationRun
}

type pluginRecord struct {
	desired    *ServiceSpec
	service    *serviceState
	transition *transitionState

	sockets map[socketCloser]struct{}
}

// pendingRequest reads through a possibly absent service: a record without one has no pending start.
func (r *pluginRecord) pendingRequest() *startRequest {
	if r.service == nil {
		return nil
	}

	return r.service.pending
}

// phase reads through a possibly absent service: a record without one has no launch and no process.
func (r *pluginRecord) phase() procPhase {
	if r.service == nil {
		return nil
	}

	return r.service.proc
}

// slot reads through a possibly absent service: a record without one has no slot.
func (r *pluginRecord) slot() slotState {
	if r.service == nil {
		return slotNone
	}

	return r.service.slot
}

func (cfg SupervisorConfig) withDefaults() SupervisorConfig {
	cfg.Limits = cfg.Limits.WithDefaults()

	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}

	if cfg.ReadinessTimeout <= 0 {
		cfg.ReadinessTimeout = DefaultServiceHTTPTimeout
	}

	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = DefaultStandaloneStopTimeout
	}

	if cfg.DiagnosticsTimeout <= 0 {
		cfg.DiagnosticsTimeout = 2 * time.Second
	}

	if cfg.FinalReapTimeout <= 0 {
		cfg.FinalReapTimeout = DefaultFinalReapTimeout
	}

	if cfg.Now == nil {
		cfg.Now = time.Now
	}

	if cfg.LifetimeCtx == nil {
		cfg.LifetimeCtx = context.Background()
	}

	return cfg
}

func newSupervisor(cfg SupervisorConfig, admission *Admission) *Supervisor {
	cfg = cfg.withDefaults()

	supervisor := &Supervisor{
		cfg:         cfg,
		admission:   admission,
		plugins:     make(map[string]*pluginRecord),
		lifetimeCtx: cfg.LifetimeCtx,
		now:         cfg.Now,
	}
	supervisor.launchServiceFunc = supervisor.launchService
	supervisor.waitProcessFunc = func(command *exec.Cmd) error { return command.Wait() }

	if invariantChecksEnabled {
		registerInvariantSupervisor(supervisor)
	}

	if supervisor.lifetimeCtx.Done() != nil {
		context.AfterFunc(supervisor.lifetimeCtx, func() {
			supervisor.mu.Lock()

			supervisor.shuttingDown = true

			supervisor.clearDesiredLocked()

			supervisor.stopRetryTimersLocked()
			supervisor.unlock()
		})
	}

	return supervisor
}

func (s *Supervisor) ensurePluginRecordLocked(pluginID string) *pluginRecord {
	record := s.plugins[pluginID]

	if record == nil {
		record = &pluginRecord{}
		s.plugins[pluginID] = record
	}

	return record
}

func (s *Supervisor) serviceRecordLocked(pluginID string) *pluginRecord {
	record := s.plugins[pluginID]

	if record == nil || record.service == nil {
		return nil
	}

	return record
}

func (s *Supervisor) transitionRecordLocked(pluginID string) *pluginRecord {
	record := s.plugins[pluginID]

	if record == nil || record.transition == nil {
		return nil
	}

	return record
}

func (s *Supervisor) ensureTransitionRecordLocked(pluginID string) *pluginRecord {
	record := s.ensurePluginRecordLocked(pluginID)

	if record.transition == nil {
		record.transition = &transitionState{}
	}

	return record
}

func (s *Supervisor) ensureServiceRecordLocked(pluginID string) *pluginRecord {
	record := s.ensurePluginRecordLocked(pluginID)

	if record.service == nil {
		record.service = &serviceState{status: RuntimeStatus{State: StateStopped}}
	}

	return record
}

// acquireServiceSlotLocked requires record.service.
func (s *Supervisor) acquireServiceSlotLocked(record *pluginRecord) bool {
	if record.service.slot != slotNone {
		return true
	}

	if s.reservedServices >= s.cfg.Limits.MaxSupervisedServices {
		return false
	}

	record.service.slot = slotHeld
	s.reservedServices++

	return true
}

// releaseServiceSlotLocked requires record.service.
func (s *Supervisor) releaseServiceSlotLocked(record *pluginRecord) bool {
	if record.service.slot == slotNone || record.service.proc != nil {
		return false
	}

	record.service.slot = slotNone
	s.reservedServices--

	return true
}

func (s *Supervisor) reservedServiceCount() int {
	s.mu.Lock()

	defer s.unlock()

	return s.reservedServices
}

func (s *Supervisor) trackSocket(conn socketCloser, pluginID string) (func(), bool) {
	s.mu.Lock()

	if s.platformMaintenance {
		s.unlock()

		return func() {}, false
	}

	for trackedPluginID, record := range s.plugins {
		if trackedPluginID != pluginID {
			if _, tracked := record.sockets[conn]; tracked {
				delete(record.sockets, conn)
				s.prunePluginRecordLocked(trackedPluginID)
			}
		}
	}

	record := s.ensurePluginRecordLocked(pluginID)

	if record.sockets == nil {
		record.sockets = make(map[socketCloser]struct{})
	}

	record.sockets[conn] = struct{}{}

	s.unlock()

	return func() {
		s.untrackSocket(conn)
	}, true
}

func (s *Supervisor) untrackSocket(conn socketCloser) {
	s.mu.Lock()

	for pluginID, record := range s.plugins {
		if _, tracked := record.sockets[conn]; tracked {
			delete(record.sockets, conn)
			s.prunePluginRecordLocked(pluginID)
		}
	}

	s.unlock()
}

func (s *Supervisor) closePluginSockets(pluginID string) {
	s.mu.Lock()

	connections := make([]socketCloser, 0)

	if record := s.plugins[pluginID]; record != nil {
		for conn := range record.sockets {
			connections = append(connections, conn)
		}
	}

	s.unlock()

	closeSockets(connections)
}

func (s *Supervisor) beginPlatformMaintenance() {
	s.mu.Lock()

	s.platformMaintenance = true
	connections := make([]socketCloser, 0)

	for _, record := range s.plugins {
		for conn := range record.sockets {
			connections = append(connections, conn)
		}
	}

	s.unlock()

	closeSockets(connections)
}

func (s *Supervisor) platformMaintenanceActive() bool {
	s.mu.Lock()

	defer s.unlock()

	return s.platformMaintenance
}

func (s *Supervisor) setDesiredLocked(pluginID string, desired *ServiceSpec) {
	if desired == nil {
		if record := s.plugins[pluginID]; record != nil {
			s.clearPendingStartLocked(record)

			record.desired = nil

			s.prunePluginRecordLocked(pluginID)
		}

		return
	}

	record := s.ensurePluginRecordLocked(pluginID)

	if pending := record.pendingRequest(); pending != nil && !pending.spec.Equal(*desired) {
		s.clearPendingStartLocked(record)
	}

	desiredCopy := *desired
	record.desired = &desiredCopy
}

func (s *Supervisor) clearDesiredLocked() {
	for pluginID, record := range s.plugins {
		if record.desired != nil {
			record.desired = nil

			s.prunePluginRecordLocked(pluginID)
		}
	}
}

// A union record remains while any desired, service, transition, socket, process, slot, startup, or retry ownership exists.
func (s *Supervisor) prunePluginRecordLocked(pluginID string) {
	record := s.plugins[pluginID]

	if record == nil || record.desired != nil || record.service != nil || record.transition != nil ||
		record.pendingRequest() != nil || len(record.sockets) > 0 {
		return
	}

	delete(s.plugins, pluginID)
}

// beginLocked requires Supervisor.mu held.
func (s *Supervisor) beginLocked(name string, op Operation, want Intent) beginOutcome {
	record := s.transitionRecordLocked(name)

	if record != nil && record.transition.operation != OpNone {
		if record.transition.operation == op && traitsOf(op).joinable {
			return beginOutcome{run: record.transition.run, joined: true}
		}

		if traitsOf(op).supersedes && traitsOf(record.transition.operation).supersedable {
			oldRun := record.transition.run
			priorIntent := record.transition.intent

			s.completeSupersededLocked(oldRun)
			oldRun.cancel()

			run := s.newRunLocked(name, op, want)
			record = s.ensureTransitionRecordLocked(name)
			record.transition.intent = want
			record.transition.operation = op
			record.transition.priorIntent = priorIntent
			record.transition.run = run

			return beginOutcome{run: run, supersededWorkDone: oldRun.workDone}
		}

		return beginOutcome{conflict: true}
	}

	priorIntent := IntentRemove

	if record != nil {
		priorIntent = record.transition.intent

		if record.transition.intent == IntentRemove && op != OpInstalling && op != OpDeleting {
			return beginOutcome{conflict: true}
		}
	}

	run := s.newRunLocked(name, op, want)
	record = s.ensureTransitionRecordLocked(name)
	record.transition.intent = want
	record.transition.operation = op
	record.transition.priorIntent = priorIntent
	record.transition.run = run

	return beginOutcome{run: run}
}

// isCurrentLocked requires Supervisor.mu held.
func (s *Supervisor) isCurrentLocked(run *operationRun) bool {
	if run == nil || run.completed {
		return false
	}

	record := s.transitionRecordLocked(run.name)

	return record != nil && record.transition.run == run && record.transition.operation == run.op
}

// commitLocked requires Supervisor.mu held. Like every rule below that ends a run, it returns effects for the caller
// to run after unlocking.
func (s *Supervisor) commitLocked(run *operationRun) []effect {
	if run == nil {
		return nil
	}

	if run.targetIntent == IntentRemove {
		if !s.isCurrentLocked(run) {
			return nil
		}

		s.nextGen++
	}

	return s.terminalizeLocked(run, run.targetIntent, nil)
}

// failRestoreLocked requires Supervisor.mu held.
func (s *Supervisor) failRestoreLocked(run *operationRun, err error) []effect {
	if run == nil {
		return nil
	}

	record := s.transitionRecordLocked(run.name)

	if record == nil {
		return nil
	}

	return s.terminalizeLocked(run, record.transition.priorIntent, err)
}

// failKeepLocked requires Supervisor.mu held.
func (s *Supervisor) failKeepLocked(run *operationRun, err error) []effect {
	if run == nil {
		return nil
	}

	return s.terminalizeLocked(run, run.targetIntent, err)
}

// failLocked requires Supervisor.mu held.
func (s *Supervisor) failLocked(run *operationRun, err error) []effect {
	if run == nil {
		return nil
	}

	if traitsOf(run.op).restoreOnFail {
		return s.failRestoreLocked(run, err)
	}

	return s.failKeepLocked(run, err)
}

// forceStopLocked requires Supervisor.mu held.
func (s *Supervisor) forceStopLocked(run *operationRun, err error) []effect {
	return s.terminalizeLocked(run, IntentStop, err)
}

func (s *Supervisor) newRunLocked(name string, op Operation, want Intent) *operationRun {
	s.nextGen++
	ctx, cancel := context.WithCancel(s.lifetimeCtx)

	return &operationRun{
		name:         name,
		generation:   s.nextGen,
		op:           op,
		targetIntent: want,
		ctx:          ctx,
		done:         make(chan struct{}),
		workDone:     make(chan struct{}),
		cancel:       cancel,
	}
}

// terminalizeLocked ends the current run and settles in the same critical section: the plugin's own pending start
// first, then admission, because the ended operation can make this plugin or a blocked one admissible.
func (s *Supervisor) terminalizeLocked(run *operationRun, intent Intent, err error) []effect {
	if !s.isCurrentLocked(run) {
		return nil
	}

	record := s.transitionRecordLocked(run.name)
	record.transition.intent = intent
	record.transition.operation = OpNone
	run.result = err
	run.completed = true

	run.cancel()
	close(run.done)

	return s.settleAndAdmitLocked(run.name)
}

func (s *Supervisor) completeSupersededLocked(run *operationRun) {
	if run == nil || run.completed {
		return
	}

	run.result = errSuperseded
	run.completed = true

	close(run.done)
}

func (s *Supervisor) beginLifecycle(name string, op Operation, intent Intent) beginOutcome {
	s.mu.Lock()

	defer s.unlock()

	return s.beginLocked(name, op, intent)
}

func lifecycleOperationFromOutcome(outcome beginOutcome) lifecycleOperation {
	operation := lifecycleOperation{
		joined:             outcome.joined,
		conflict:           outcome.conflict,
		supersededWorkDone: outcome.supersededWorkDone,
	}

	if outcome.run != nil {
		operation.token = &lifecycleToken{run: outcome.run}
	}

	return operation
}

func (s *Supervisor) beginLifecycleOperation(name string, op Operation, intent Intent) lifecycleOperation {
	return lifecycleOperationFromOutcome(s.beginLifecycle(name, op, intent))
}

func (s *Supervisor) beginDesiredStartupOutcome(spec ServiceSpec) beginOutcome {
	s.mu.Lock()

	defer s.unlock()

	desired := s.plugins[spec.PluginID]
	transitionRecord := s.transitionRecordLocked(spec.PluginID)

	if s.shuttingDown || s.lifetimeCtx.Err() != nil || desired == nil || desired.desired == nil || !desired.desired.Enabled ||
		!desired.desired.Equal(spec) || transitionRecord == nil || transitionRecord.transition.intent != IntentRun ||
		transitionRecord.transition.operation != OpNone {
		return beginOutcome{conflict: true}
	}

	if service := s.serviceRecordLocked(spec.PluginID); service != nil {
		service.service.startup = nil
	}

	return s.beginLocked(spec.PluginID, OpStarting, IntentRun)
}

func (s *Supervisor) beginDesiredStartup(spec ServiceSpec) lifecycleOperation {
	return lifecycleOperationFromOutcome(s.beginDesiredStartupOutcome(spec))
}

func (s *Supervisor) isLifecycleCurrent(token *lifecycleToken) bool {
	return token != nil && s.isCurrent(token.run)
}

func (s *Supervisor) waitLifecycle(token *lifecycleToken) error {
	if token == nil {
		return nil
	}

	return waitRun(token.run)
}

func (s *Supervisor) startDesiredService(token *lifecycleToken, spec ServiceSpec) error {
	if !s.isLifecycleCurrent(token) {
		return errSuperseded
	}

	return s.startService(token.run, spec)
}

func (s *Supervisor) startServiceForLifecycle(token *lifecycleToken, spec ServiceSpec) error {
	if token == nil {
		return errSuperseded
	}

	return s.startService(token.run, spec)
}

func (s *Supervisor) stopServiceForLifecycle(token *lifecycleToken) error {
	if token == nil {
		return errSuperseded
	}

	return s.stopService(token.run)
}

func (s *Supervisor) markLifecycleServiceReady(token *lifecycleToken, record *pluginRecord) bool {
	return token != nil && s.markServiceReady(token.run, record)
}

func (s *Supervisor) releaseUnstartedReservationForLifecycle(token *lifecycleToken) (bool, []effect) {
	if token == nil {
		return false, nil
	}

	return s.releaseUnstartedReservation(token.run)
}

func (s *Supervisor) runLifecycleWork(
	token *lifecycleToken,
	control LifecycleControl,
	work func(context.Context, LifecycleControl) error,
) (err error) {
	if token == nil {
		return errSuperseded
	}

	run := token.run

	defer close(run.workDone)

	defer func() {
		if recovered := recover(); recovered != nil {
			stack := debug.Stack()
			err = fmt.Errorf("%w: %v", errWorkPanic, recovered)

			s.cfg.Logger.Error("lifecycle work panicked", "plugin", run.name, "operation", run.op, "panic", recovered, "stack", string(stack))
		}
	}()

	return work(run.ctx, control)
}

func (s *Supervisor) finishLifecycle(token *lifecycleToken, op Operation) *LifecycleEvent {
	if token == nil {
		return nil
	}

	run := token.run

	s.mu.Lock()

	effects := s.commitLocked(run)

	s.unlock()

	s.runEffects(effects)

	state := LifecycleStopped
	reason := lifecycleStopReason(op, run.targetIntent)

	if run.targetIntent == IntentRun {
		state = LifecycleStarted
		reason = LifecycleReasonReconciled
	}

	return &LifecycleEvent{Plugin: run.name, State: state, Reason: reason}
}

func (s *Supervisor) failLifecycle(token *lifecycleToken, err error) {
	if token == nil {
		return
	}

	var effects []effect

	s.mu.Lock()

	if errors.Is(err, ErrForceStopTerminal) {
		effects = s.forceStopLocked(token.run, err)
	} else {
		effects = s.failLocked(token.run, err)
	}

	s.unlock()

	s.runEffects(effects)
}

func (s *Supervisor) blocksTraffic(pluginID string) bool {
	s.mu.Lock()

	defer s.unlock()

	record := s.transitionRecordLocked(pluginID)

	if record == nil {
		return false
	}

	if record.transition.intent == IntentStop || record.transition.intent == IntentRemove {
		return true
	}

	return traitsOf(record.transition.operation).exclusive
}

func (s *Supervisor) transitionStateLocked(pluginID string) transitionSnapshot {
	record := s.transitionRecordLocked(pluginID)

	if record == nil {
		return transitionSnapshot{intent: IntentRemove}
	}

	snapshot := transitionSnapshot{
		present:   true,
		intent:    record.transition.intent,
		operation: record.transition.operation,
	}

	if record.transition.run != nil {
		snapshot.generation = record.transition.run.generation
	}

	return snapshot
}

func (s *Supervisor) trackDesiredStartupLocked(spec ServiceSpec) []effect {
	if s.shuttingDown || s.lifetimeCtx.Err() != nil || s.startDesired == nil {
		return nil
	}

	desiredRecord := s.plugins[spec.PluginID]
	serviceRecord := s.serviceRecordLocked(spec.PluginID)
	transitionRecord := s.transitionRecordLocked(spec.PluginID)

	if desiredRecord == nil || desiredRecord.desired == nil || !desiredRecord.desired.Enabled ||
		!desiredRecord.desired.Equal(spec) || serviceRecord == nil || transitionRecord == nil || transitionRecord.transition.intent != IntentRun ||
		transitionRecord.transition.operation != OpNone {
		return nil
	}

	if serviceRecord.service.launching() != nil || serviceRecord.service.stop != nil ||
		(serviceRecord.service.process() != nil && serviceRecord.service.spec.Equal(spec)) {
		s.markPendingStartLocked(serviceRecord, spec, false)

		return nil
	}

	if serviceRecord.service.startup != nil {
		return nil
	}

	ticket := &startupTicket{spec: spec}
	serviceRecord.service.startup = ticket

	s.addStartupLocked()

	return []effect{startupEffect{spec: spec, ticket: ticket, start: s.startDesired}}
}

func (s *Supervisor) transitionGenerationLocked(pluginID string) uint64 {
	transition := s.transitionRecordLocked(pluginID)

	if transition == nil || transition.transition.run == nil {
		return 0
	}

	return transition.transition.run.generation
}

func (s *Supervisor) markPendingStartLocked(record *pluginRecord, spec ServiceSpec, retry bool) {
	s.stopRetryTimerLocked(spec.PluginID)

	spec.Args = append([]string(nil), spec.Args...)

	record.service.pending = &startRequest{
		spec:       spec,
		retry:      retry,
		generation: s.transitionGenerationLocked(spec.PluginID),
	}
}

func (s *Supervisor) launchDesiredStartup(spec ServiceSpec) {
	s.mu.Lock()

	effects := s.trackDesiredStartupLocked(spec)

	s.unlock()

	s.runEffects(effects)
}

func (s *Supervisor) isCurrent(run *operationRun) bool {
	s.mu.Lock()

	defer s.unlock()

	return s.isCurrentLocked(run)
}

type stopOperationResult struct {
	err    error
	record *pluginRecord
	stop   *stopState
}

// StopAll stops every supervised service and removes its runtime evidence.
func (s *Supervisor) StopAll(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()

	s.shuttingDown = true
	idle := s.startupsIdleLocked()

	s.clearDesiredLocked()

	s.stopRetryTimersLocked()

	for _, record := range s.plugins {
		if record.transition != nil && record.transition.run != nil && !record.transition.run.completed {
			record.transition.run.cancel()
		}
	}

	s.unlock()
	<-idle

	s.mu.Lock()

	pluginIDs := make([]string, 0, len(s.plugins))

	for pluginID, record := range s.plugins {
		if record.service != nil {
			pluginIDs = append(pluginIDs, pluginID)
		}
	}

	s.unlock()
	slices.Sort(pluginIDs)

	stopResults := make([]stopOperationResult, len(pluginIDs))
	var stops sync.WaitGroup

	for index, pluginID := range pluginIDs {
		stops.Add(1)

		go func(index int, pluginID string) {
			defer stops.Done()

			s.mu.Lock()

			record := s.plugins[pluginID]

			s.unlock()

			stopErr := s.stopRecord(ctx, pluginID)

			var stop *stopState

			if record != nil {
				s.mu.Lock()

				if record.service != nil {
					stop = record.service.stop
				}

				s.unlock()
			}

			stopResults[index] = stopOperationResult{err: stopErr, record: record, stop: stop}
		}(index, pluginID)
	}

	stops.Wait()
	s.waitForStopFinalizers(ctx, stopResults)

	stopErrors := make([]error, len(stopResults))

	for index, result := range stopResults {
		stopErrors[index] = result.err
	}

	stopErrors = append(stopErrors, ctx.Err())

	return errors.Join(stopErrors...)
}

func (s *Supervisor) waitForStopFinalizers(ctx context.Context, results []stopOperationResult) {
	waitCtx, cancel := context.WithTimeout(ctx, s.cfg.FinalReapTimeout)

	defer cancel()

	var waiters sync.WaitGroup

	for index, result := range results {
		if result.record == nil {
			continue
		}

		if result.stop == nil {
			s.mu.Lock()

			if result.record.service != nil {
				results[index].err = result.record.service.lastStopErr
			}

			s.unlock()

			continue
		}

		waiters.Add(1)

		go func(index int, result stopOperationResult) {
			defer waiters.Done()

			if !stopFinished(waitCtx, result.stop.done) {
				return
			}

			results[index].err = result.stop.err
		}(index, result)
	}

	waiters.Wait()
}

func stopFinished(ctx context.Context, done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	case <-ctx.Done():
		select {
		case <-done:
			return true
		default:
			return false
		}
	}
}

func (s *Supervisor) runningPluginIDs() []string {
	s.mu.Lock()

	defer s.unlock()

	pluginIDs := make([]string, 0, len(s.plugins))

	for pluginID, record := range s.plugins {
		if record.service != nil {
			pluginIDs = append(pluginIDs, pluginID)
		}
	}

	slices.Sort(pluginIDs)

	return pluginIDs
}

type reconcilePlan struct {
	startIDs  []string
	stopIDs   []string
	removeIDs []string
	// effects start plugins that admission handed a slot to ahead of a candidate; the caller runs them.
	effects []effect
}

// lessServiceSpec is the supervisor's ordering policy: builtin services first, then by PluginID.
// Both start (Reconcile) and admission (admitQueueLocked) sort by it so they act in one consistent order.
func lessServiceSpec(a, b ServiceSpec) bool {
	if a.Builtin != b.Builtin {
		return a.Builtin
	}

	return a.PluginID < b.PluginID
}

func (s *Supervisor) Reconcile(ctx context.Context, specs []ServiceSpec) reconcilePlan {
	if ctx == nil {
		ctx = context.Background()
	}

	if ctx.Err() != nil {
		return reconcilePlan{}
	}

	ordered := slices.Clone(specs)

	slices.SortStableFunc(ordered, func(left, right ServiceSpec) int {
		if lessServiceSpec(left, right) {
			return -1
		}

		if lessServiceSpec(right, left) {
			return 1
		}

		return 0
	})

	s.mu.Lock()

	defer s.unlock()

	if ctx.Err() != nil || s.shuttingDown || s.lifetimeCtx.Err() != nil {
		return reconcilePlan{}
	}

	plan := reconcilePlan{}
	authoritative := make(map[string]struct{}, len(ordered))

	for _, spec := range ordered {
		authoritative[spec.PluginID] = struct{}{}
		want := IntentStop

		if spec.RemovalPending {
			want = IntentRemove
		} else if spec.Enabled {
			want = IntentRun
		}

		if want != IntentRun {
			s.stopRetryTimerLocked(spec.PluginID)

			if record := s.plugins[spec.PluginID]; record != nil {
				s.clearPendingStartLocked(record)
			}
		}

		transitionRecord := s.transitionRecordLocked(spec.PluginID)

		if transitionRecord == nil {
			transitionRecord = s.ensureTransitionRecordLocked(spec.PluginID)
			transitionRecord.transition.intent = want
			transitionRecord.transition.operation = OpNone
		} else if transitionRecord.transition.operation == OpNone && transitionRecord.transition.intent != IntentRemove {
			transitionRecord.transition.intent = want
		}

		if transitionRecord.transition.operation != OpNone {
			continue
		}

		if transitionRecord.transition.intent == IntentRemove {
			s.setDesiredLocked(spec.PluginID, nil)

			plan.removeIDs = append(plan.removeIDs, spec.PluginID)

			continue
		}

		spec.Enabled = transitionRecord.transition.intent == IntentRun && spec.Enabled

		s.setDesiredLocked(spec.PluginID, &spec)

		service := s.serviceRecordLocked(spec.PluginID)

		if service != nil && !service.service.spec.Equal(spec) {
			s.stopRetryTimerLocked(spec.PluginID)
		}

		if transitionRecord.transition.intent == IntentStop {
			if service != nil && (service.service.status.State != StateStopped || service.service.slot != slotNone) {
				plan.stopIDs = append(plan.stopIDs, spec.PluginID)
			}

			continue
		}

		if service == nil || service.service.status.State == StateStopped || service.service.status.State == StateCapacityBlocked ||
			!service.service.spec.Equal(spec) {
			reserved, effects := s.reserveForReconcileLocked(spec)

			plan.effects = append(plan.effects, effects...)

			if !reserved && service != nil && service.service.stop != nil {
				s.markPendingStartLocked(service, spec, false)
			}

			if reserved {
				plan.startIDs = append(plan.startIDs, spec.PluginID)
			}
		}
	}

	for pluginID, service := range s.plugins {
		if service.service == nil {
			continue
		}

		if _, exists := authoritative[pluginID]; exists {
			continue
		}

		s.setDesiredLocked(pluginID, nil)
		s.stopRetryTimerLocked(pluginID)

		transitionRecord := s.transitionRecordLocked(pluginID)

		if transitionRecord != nil && transitionRecord.transition.operation != OpNone {
			continue
		}

		if transitionRecord == nil {
			transitionRecord = s.ensureTransitionRecordLocked(pluginID)
			transitionRecord.transition.intent = IntentRemove
			transitionRecord.transition.operation = OpNone
		} else {
			transitionRecord.transition.intent = IntentRemove
		}

		plan.removeIDs = append(plan.removeIDs, pluginID)
	}

	slices.Sort(plan.stopIDs)
	slices.Sort(plan.removeIDs)

	return plan
}

// reserveForReconcileLocked makes service admission follow the sorted Reconcile order.
// The returned candidate already owns its slot before Runtime launches startup work. The effects start plugins that
// the admission queue admitted ahead of this one; the caller runs them after unlocking.
func (s *Supervisor) reserveForReconcileLocked(spec ServiceSpec) (bool, []effect) {
	record, done, ok := s.prepareReservationLocked(spec)

	if done {
		return ok, nil
	}

	granted, effects := s.requestSlotLocked(record, spec)

	s.finishReservationLocked(record, spec, granted)

	return granted, effects
}

// prepareReservationLocked is everything reserveForReconcileLocked decides before it needs a slot. When done is
// true, ok is the answer and no slot is involved.
func (s *Supervisor) prepareReservationLocked(spec ServiceSpec) (record *pluginRecord, done, ok bool) {
	record = s.serviceRecordLocked(spec.PluginID)

	if record == nil {
		record = s.ensureServiceRecordLocked(spec.PluginID)
		record.service.spec = spec
	} else if record.service.process() == nil && (record.service.status.State == StateStopped || record.service.status.State == StateCapacityBlocked) {
		// No process is using the old spec, so a pre-launch update can safely
		// replace the record spec without forcing a stop/re-reserve cycle.
		record.service.spec = spec
	}

	if record.service.stop != nil {
		return record, true, false
	}

	compatible := s.supportedProtocol(spec.ProtocolVersion)

	if !compatible {
		if record.service.status.State == StateCapacityBlocked {
			record.service.status.State = StateStopped
			record.service.status.NextAttemptAt = nil
		}

		return record, true, true
	}

	if record.service.slot != slotNone {
		if record.service.status.State == StateCapacityBlocked {
			record.service.setReservation(record.service.process() == nil)
		}

		return record, true, true
	}

	return record, false, false
}

// finishReservationLocked writes the status that follows the slot decision of a reservation.
func (s *Supervisor) finishReservationLocked(record *pluginRecord, spec ServiceSpec, granted bool) {
	if granted {
		record.service.setReservation(record.service.status.State == StateStopped || record.service.status.State == StateCapacityBlocked)

		return
	}

	compatible := s.supportedProtocol(spec.ProtocolVersion)

	record.service.status.State = StateCapacityBlocked
	record.service.status.NextAttemptAt = nil
	record.service.status.RequiredProtocol = spec.ProtocolVersion
	record.service.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
	record.service.status.Compatible = &compatible
}

// admissionOpenLocked says whether admission may start plugins other than a requester.
func (s *Supervisor) admissionOpenLocked() bool {
	return !s.shuttingDown && s.lifetimeCtx.Err() == nil && s.startDesired != nil
}

// admissibleLocked is I13's definition of a plugin the admission queue may hand a slot to.
func (s *Supervisor) admissibleLocked(pluginID string, plugin *pluginRecord) bool {
	service := s.serviceRecordLocked(pluginID)
	transition := s.transitionRecordLocked(pluginID)

	return plugin.desired != nil && plugin.desired.Enabled && service != nil && service.service.slot == slotNone &&
		service.service.status.State == StateCapacityBlocked && service.service.stop == nil && transition != nil &&
		transition.transition.operation == OpNone && transition.transition.intent == IntentRun
}

// admitLocked hands free slots to admissible capacity-blocked plugins in lessServiceSpec order and returns their
// startup effects. Admissible is I13's definition: service present, desired.Enabled, no slot, StateCapacityBlocked,
// operation OpNone, intent IntentRun, no stop. It does nothing while shutting down, after the lifetime ends, or
// before startDesired is set.
func (s *Supervisor) admitLocked() []effect {
	_, effects := s.admitQueueLocked(nil, ServiceSpec{})

	return effects
}

// settleAndAdmitLocked is the tail every event rule ends with: the plugin's own pending start first, then the slot
// the plugin no longer owns, then admission, so a slot freed here goes to the first waiter in the same critical
// section.
func (s *Supervisor) settleAndAdmitLocked(pluginID string) []effect {
	effects := s.settleLocked(pluginID)

	s.releaseOwnerlessSlotLocked(s.plugins[pluginID])

	return append(effects, s.admitLocked()...)
}

// keepRestartSlotLocked decides what a restart with a changed spec does with the slot the old process held. A spec
// the daemon can run keeps the slot, as an unclaimed reservation until the start claims it. An incompatible spec
// cannot start, so the slot is released at once, as reserveForReconcileLocked does not ask for one for it, and the
// first admissible waiter gets it in the caller's tail.
func (s *Supervisor) keepRestartSlotLocked(record *pluginRecord, spec ServiceSpec) {
	if s.supportedProtocol(spec.ProtocolVersion) {
		record.service.unclaimSlot()

		return
	}

	s.releaseServiceSlotLocked(record)
}

// releaseOwnerlessSlotLocked releases a held slot that nothing owns any more and reports whether it did. Ownerless
// means: held, no process phase, no stop, no pending start, no startup ticket, no active run of this plugin, and the
// status is StateStopped (a restart that did not continue) or StateFailed (past the retry cutoff). Every other state
// without a process either has an owner that will act (backoff, a retry or startup in flight) or is not this rule's
// to judge.
//
// The predicate is I14's violation condition limited to Stopped and Failed. Its pending-start and startup-ticket
// terms are kept on purpose: no current path reaches a held, Stopped or Failed slot with either of them set, but
// dropping them would stop the rule from reading as I14's violation and let a later step release a slot that
// still has an owner.
func (s *Supervisor) releaseOwnerlessSlotLocked(record *pluginRecord) bool {
	if record == nil || record.service == nil {
		return false
	}

	service := record.service
	activeRun := record.transition != nil && record.transition.run != nil && !record.transition.run.completed

	if service.slot != slotHeld || service.proc != nil || service.stop != nil || service.pending != nil ||
		service.startup != nil || activeRun ||
		(service.status.State != StateStopped && service.status.State != StateFailed) {
		return false
	}

	return s.releaseServiceSlotLocked(record)
}

// requestSlotLocked is how a starting plugin asks for a slot: the requester joins the queue for this one pass (it
// counts as admissible even though its own operation is in flight), the admission loop runs over the queue in
// lessServiceSpec order, and the requester learns whether it got a slot. Plugins admitted before it in that pass
// get startup effects, returned to the caller. A plugin that already owns a slot does not ask: a restart keeps it.
func (s *Supervisor) requestSlotLocked(record *pluginRecord, spec ServiceSpec) (bool, []effect) {
	if record.service.slot != slotNone {
		return true, nil
	}

	return s.admitQueueLocked(record, spec)
}

type admissionCandidate struct {
	spec      ServiceSpec
	requester bool
}

// admitQueueLocked is the one admission loop behind admitLocked (requester == nil) and requestSlotLocked. It is the
// only caller of acquireServiceSlotLocked.
func (s *Supervisor) admitQueueLocked(requester *pluginRecord, requesterSpec ServiceSpec) (bool, []effect) {
	var queue []admissionCandidate

	if s.admissionOpenLocked() {
		for pluginID, plugin := range s.plugins {
			if (requester == nil || plugin != requester) && s.admissibleLocked(pluginID, plugin) {
				queue = append(queue, admissionCandidate{spec: *plugin.desired})
			}
		}
	}

	if requester != nil {
		queue = append(queue, admissionCandidate{spec: requesterSpec, requester: true})
	}

	slices.SortStableFunc(queue, func(left, right admissionCandidate) int {
		if lessServiceSpec(left.spec, right.spec) {
			return -1
		}

		if lessServiceSpec(right.spec, left.spec) {
			return 1
		}

		return 0
	})

	granted := false
	effects := make([]effect, 0, len(queue))

	for _, candidate := range queue {
		if candidate.requester {
			granted = s.acquireServiceSlotLocked(requester)

			continue
		}

		if s.admitCandidateLocked(candidate.spec) {
			effects = append(effects, s.trackDesiredStartupLocked(candidate.spec)...)
		}
	}

	return granted, effects
}

// admitCandidateLocked reserves a slot for a capacity-blocked plugin and reports whether its startup may begin.
func (s *Supervisor) admitCandidateLocked(spec ServiceSpec) bool {
	record, done, ok := s.prepareReservationLocked(spec)

	if done {
		return ok
	}

	granted := s.acquireServiceSlotLocked(record)

	s.finishReservationLocked(record, spec, granted)

	return granted
}

type startAction int

const (
	// startNoop means Start should return plan.err without launching a process.
	startNoop startAction = iota
	// startProceed means the record is reserved and marked starting; launch it.
	startProceed
	// startStopIncompatible means an old runtime must be stopped, then the
	// incompatible protocol status re-stamped, before returning plan.err.
	startStopIncompatible
	// startReplace means a live service has a different desired spec and must
	// be stopped before the replacement process is launched.
	startReplace
)

type startPlan struct {
	record *pluginRecord
	action startAction
	err    error
	// effects start plugins that admission handed a slot to ahead of this one; planStartForRun runs them.
	effects []effect
}

func (s *Supervisor) planStartForRun(run *operationRun, spec ServiceSpec, paths RuntimePaths) startPlan {
	s.mu.Lock()

	if !s.isCurrentLocked(run) {
		s.unlock()

		return startPlan{action: startNoop, err: errSuperseded}
	}

	plan := s.planStartLocked(spec, paths)

	s.unlock()

	s.runEffects(plan.effects)

	plan.effects = nil

	return plan
}

func (s *Supervisor) planStartLocked(spec ServiceSpec, paths RuntimePaths) startPlan {
	if s.shuttingDown {
		return startPlan{action: startNoop, err: context.Canceled}
	}

	if err := s.lifetimeCtx.Err(); err != nil {
		return startPlan{action: startNoop, err: err}
	}

	s.setDesiredLocked(spec.PluginID, &spec)

	record := s.serviceRecordLocked(spec.PluginID)
	previousSpec := ServiceSpec{}

	if record != nil {
		previousSpec = record.service.spec
	}

	if record == nil {
		record = s.ensureServiceRecordLocked(spec.PluginID)
		record.service.paths = paths
		record.service.spec = spec
	} else {
		if record.service.proc == nil {
			record.service.spec = spec
		}

		record.service.paths = paths
	}

	record.service.status.RequiredProtocol = spec.ProtocolVersion
	record.service.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
	compatible := s.supportedProtocol(spec.ProtocolVersion)
	record.service.status.Compatible = &compatible

	if !compatible {
		unsupported := fmt.Errorf("unsupported service protocol %d", spec.ProtocolVersion)

		if record.service.proc != nil || record.service.slot != slotNone {
			return startPlan{record: record, action: startStopIncompatible, err: unsupported}
		}

		return startPlan{record: record, action: startNoop, err: unsupported}
	}

	if record.service.launching() != nil {
		if !previousSpec.Equal(spec) {
			s.markPendingStartLocked(record, spec, false)
		}

		return startPlan{action: startNoop}
	}

	if record.service.process() != nil {
		if !previousSpec.Equal(spec) {
			s.markPendingStartLocked(record, spec, false)

			if !record.service.registered() {
				return startPlan{action: startNoop}
			}

			return startPlan{record: record, action: startReplace}
		}

		if record.service.stop != nil {
			s.markPendingStartLocked(record, spec, false)
		}

		return startPlan{action: startNoop}
	}

	// A changed spec restarts the plugin and it keeps the slot it holds; only the status starts over.
	if !previousSpec.Equal(spec) && record.service.slot != slotNone {
		record.service.status.State = StateStopped
		record.service.status.NextAttemptAt = nil
	}

	now := s.now()

	if record.service.status.State == StateReady || record.service.status.State == StateStarting {
		if !previousSpec.Equal(spec) {
			return startPlan{record: record, action: startReplace}
		}

		return startPlan{action: startNoop}
	}

	if record.service.status.State == StateBackoff && record.service.status.NextAttemptAt != nil && now.Before(*record.service.status.NextAttemptAt) {
		return startPlan{action: startNoop, err: fmt.Errorf("service is in backoff until %s", record.service.status.NextAttemptAt.Format(time.RFC3339))}
	}

	record.service.claimSlot()

	s.clearPendingStartLocked(record)

	granted, effects := s.requestSlotLocked(record, spec)

	if !granted {
		record.service.status.State = StateCapacityBlocked

		return startPlan{action: startNoop, err: ErrServiceCapacityExceeded, effects: effects}
	}

	record.service.status.State = StateStarting
	record.service.status.NextAttemptAt = nil

	return startPlan{record: record, action: startProceed, effects: effects}
}

// restampIncompatible re-applies the protocol status fields that stopProcess
// resets, so an updated-but-unsupported service stays represented as stopped
// and incompatible rather than as a bare stopped record.
func (s *Supervisor) restampIncompatible(run *operationRun, spec ServiceSpec) {
	s.mu.Lock()

	defer s.unlock()

	if !s.isCurrentLocked(run) {
		return
	}

	record := s.serviceRecordLocked(spec.PluginID)

	if record == nil {
		return
	}

	record.service.status.RequiredProtocol = spec.ProtocolVersion
	record.service.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
	compatible := s.supportedProtocol(spec.ProtocolVersion)
	record.service.status.Compatible = &compatible
}

func (s *Supervisor) startService(run *operationRun, spec ServiceSpec) error {
	if err := run.ctx.Err(); err != nil {
		return err
	}

	if !s.isCurrent(run) {
		return errSuperseded
	}

	if !spec.Enabled {
		return nil
	}

	paths, err := NewRuntimePaths(s.cfg.RuntimeRoot, spec.PluginID)
	if err != nil {
		return err
	}

	plan := s.planStartForRun(run, spec, paths)

	if !s.isCurrent(run) {
		return errSuperseded
	}

	if err := run.ctx.Err(); err != nil {
		return err
	}

	switch plan.action {
	case startStopIncompatible:
		// An updated service may already own a slot. Stop that old process,
		// then leave the incompatible manifest represented as stopped without
		// exposing a listener or scheduling retries for the unsupported version.
		_ = s.stopProcess(run.ctx, spec.PluginID, stopRelease)

		s.restampIncompatible(run, spec)

		return plan.err
	case startReplace:
		if err := s.stopProcess(run.ctx, spec.PluginID, stopRestart); err != nil {
			return err
		}

		if !s.isCurrent(run) {
			return errSuperseded
		}

		plan = s.planStartForRun(run, spec, paths)

		if plan.action != startProceed {
			return plan.err
		}
	case startNoop:
		return plan.err
	}

	record := plan.record

	validated, err := s.prepareStart(paths, spec)
	if err != nil {
		s.failStart(run, spec.PluginID, err)

		return err
	}

	if !s.isCurrent(run) {
		return errSuperseded
	}

	if err := run.ctx.Err(); err != nil {
		return err
	}

	launch, admitted := s.beginServiceLaunch(run, record)

	if !admitted {
		return errSuperseded
	}

	command, stderr, err := s.launchServiceFunc(spec, paths, validated)
	if err != nil {
		s.finishFailedLaunch(spec.PluginID, record, launch)

		s.failStart(run, spec.PluginID, err)

		return err
	}

	done := newProcessExit()
	process := &registeredProcess{
		id:            launch.id,
		runGeneration: launch.runGeneration,
		command:       command,
		exit:          done,
	}

	s.attachStartedProcess(record, launch, process)

	go func() {
		done.err = s.waitProcessFunc(command)

		close(done.done)
	}()

	if s.beforeRegistration != nil {
		s.beforeRegistration()
	}

	registered := s.registerServiceProcess(run, record, spec.PluginID, paths, process, stderr)

	if !registered {
		s.reapUnregisteredProcess(spec.PluginID, process)

		return errSuperseded
	}

	if err := s.probeServiceReadiness(run.ctx, paths, spec); err != nil {
		// Readiness can fail because run.ctx was canceled, so cleanup needs its own bounded stop window.
		s.cleanupFailedStart(spec.PluginID)

		s.failStart(run, spec.PluginID, err)

		return err
	}

	if !s.markServiceReady(run, record) {
		// Supersession cancels run.ctx too; let process cleanup finish under the configured stop timeouts.
		s.cleanupFailedStart(spec.PluginID)

		return errSuperseded
	}

	go s.observeProcessExit(spec.PluginID, process)

	return nil
}

func (s *Supervisor) beginServiceLaunch(run *operationRun, record *pluginRecord) (*launchIdentity, bool) {
	s.mu.Lock()

	defer s.unlock()

	if !s.isCurrentLocked(run) || run.ctx.Err() != nil || s.shuttingDown || s.lifetimeCtx.Err() != nil ||
		s.plugins[run.name] != record || record.service == nil || record.service.proc != nil || record.service.slot == slotNone ||
		record.service.stop != nil {
		return nil, false
	}

	s.nextProcessID++
	launch := &launchIdentity{
		id:            s.nextProcessID,
		runGeneration: run.generation,
		done:          make(chan struct{}),
	}
	record.service.proc = procLaunching{launch: launch}

	return launch, true
}

// finishFailedLaunch decides nothing about a pending start: startService runs inside a current run, so the plugin's
// operation is still set and the run's own end settles the pending start (terminalizeLocked).
func (s *Supervisor) finishFailedLaunch(pluginID string, record *pluginRecord, launch *launchIdentity) {
	s.mu.Lock()

	if s.plugins[pluginID] == record && record.service.launching() == launch {
		record.service.proc = nil

		close(launch.done)
	}

	s.unlock()
}

func (s *Supervisor) attachStartedProcess(record *pluginRecord, launch *launchIdentity, process *registeredProcess) {
	s.mu.Lock()

	// The launch record remains on its plugin until this child identity takes ownership. A different launch cannot
	// be in flight here: beginServiceLaunch refuses while proc != nil, so the phase is this launch or already cleared.
	if record.service.launching() == launch {
		close(launch.done)
	}

	record.service.proc = procStarted{process: process}

	s.unlock()
}

func (s *Supervisor) cleanupFailedStart(pluginID string) {
	cleanupCtx, cancel := context.WithTimeout(s.lifetimeCtx, s.cfg.StopTimeout+s.cfg.FinalReapTimeout)

	defer cancel()

	_ = s.stopProcess(cleanupCtx, pluginID, stopKeep)
}

func (s *Supervisor) registerServiceProcess(
	run *operationRun,
	record *pluginRecord,
	pluginID string,
	paths RuntimePaths,
	process *registeredProcess,
	stderr *StderrRing,
) bool {
	s.mu.Lock()

	started, isStarted := record.service.proc.(procStarted)
	registered := s.isCurrentLocked(run) && run.ctx.Err() == nil && !s.shuttingDown && s.lifetimeCtx.Err() == nil &&
		isStarted && started.process == process

	if registered {
		record.service.proc = procRegistered{process: process}
		record.service.recentStderr = stderr
	}

	s.unlock()

	if !registered {
		return false
	}

	if err := writeProcessLease(paths.ServiceLease, process.command.Process.Pid); err != nil {
		s.cfg.Logger.Warn("service lease unavailable", "plugin", pluginID, "error", err)
	}

	return true
}

func (s *Supervisor) probeServiceReadiness(ctx context.Context, paths RuntimePaths, spec ServiceSpec) error {
	readinessCtx, cancel := context.WithTimeout(ctx, s.cfg.ReadinessTimeout)

	defer cancel()

	err := ProbeReadiness(readinessCtx, paths.BackendSocket, spec.PluginID, spec.ProtocolVersion, s.cfg.ReadinessTimeout)

	return err
}

func (s *Supervisor) markServiceReady(run *operationRun, record *pluginRecord) bool {
	s.mu.Lock()

	defer s.unlock()

	if !s.isCurrentLocked(run) {
		return false
	}

	record.service.status.State = StateReady
	record.service.status.StartedAt = ptrTime(s.now())
	record.service.status.NextAttemptAt = nil

	return true
}

func (s *Supervisor) stopService(run *operationRun) error {
	if !s.isCurrent(run) {
		return errSuperseded
	}

	s.mu.Lock()

	if record := s.serviceRecordLocked(run.name); record != nil {
		s.clearPendingStartLocked(record)
	}

	s.unlock()

	stopCtx, cancel := context.WithTimeout(run.ctx, s.cfg.StopTimeout)

	defer cancel()

	return s.stopRecord(stopCtx, run.name)
}

func (s *Supervisor) Status(pluginID string) RuntimeStatus {
	s.mu.Lock()

	if record := s.serviceRecordLocked(pluginID); record != nil {
		status := record.service.status
		recentStderr := record.service.recentStderr

		s.unlock()

		if recentStderr != nil {
			status.RecentStderr = redactStderrLines(recentStderr.Lines())
		}

		return status
	}

	s.unlock()

	return RuntimeStatus{State: StateStopped}
}

func (s *Supervisor) SocketPath(pluginID string) (string, bool) {
	s.mu.Lock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil {
		s.unlock()

		return "", false
	}

	socketPath := record.service.paths.BackendSocket

	s.unlock()

	return socketPath, true
}

func (s *Supervisor) supportedProtocol(protocol int) bool {
	return supportsProtocol(protocol, s.cfg.SupportedProtocols)
}

func supportsProtocol(required int, supported []int) bool {
	return slices.Contains(supported, required) || (len(supported) == 0 && required == 1)
}

// SupportsProtocol reports exact membership in daemon-supported protocol versions.
func (s *Supervisor) SupportsProtocol(protocol int) bool {
	s.mu.Lock()

	defer s.unlock()

	return s.supportedProtocol(protocol)
}

func (s *Supervisor) SupportedProtocols() []int {
	s.mu.Lock()

	defer s.unlock()

	return append([]int{}, s.cfg.SupportedProtocols...)
}

func (s *Supervisor) failStart(run *operationRun, pluginID string, err error) {
	s.mu.Lock()

	defer s.unlock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil || !s.isCurrentLocked(run) {
		return
	}

	s.transitionFailureLocked(record, pluginID, "start failed", err)
}

func (s *Supervisor) observeExit(pluginID string, done *processExit) {
	s.mu.Lock()

	record := s.serviceRecordLocked(pluginID)
	var process *registeredProcess

	if record != nil {
		if current := record.service.process(); current != nil && current.exit == done {
			process = current
		}
	}

	s.unlock()

	if process != nil {
		s.observeProcessExit(pluginID, process)
	}
}

func (s *Supervisor) observeProcessExit(pluginID string, process *registeredProcess) {
	err := process.exit.wait()

	var effects []effect

	s.mu.Lock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil || record.service.stop != nil || record.service.process() != process {
		s.unlock()

		return
	}

	record.service.proc = nil

	plugin := s.plugins[pluginID]
	transition := s.transitionRecordLocked(pluginID)
	desiredChanged := plugin != nil && plugin.desired != nil && plugin.desired.Enabled &&
		!plugin.desired.Equal(record.service.spec)
	healthy := record.service.status.StartedAt != nil && s.now().Sub(*record.service.status.StartedAt) >= healthyServiceDuration

	if healthy {
		record.service.status.ConsecutiveFailures = 0
	}

	if desiredChanged && transition != nil && transition.transition.intent == IntentRun && transition.transition.operation == OpNone {
		s.stopRetryTimerLocked(pluginID)

		record.service.status.State = StateStopped
		record.service.status.NextAttemptAt = nil

		s.keepRestartSlotLocked(record, *plugin.desired)

		s.markPendingStartLocked(record, *plugin.desired, false)

		reserved, reserveEffects := s.reserveForReconcileLocked(*plugin.desired)

		effects = append(effects, reserveEffects...)

		if !reserved {
			s.clearPendingStartLocked(record)
		}
	} else if record.service.status.State != StateStopped {
		if record.service.pending != nil {
			_, retry := recordFailure(&record.service.status, s.now(), "exited", err)

			if retry {
				s.stopRetryTimerOnlyLocked(record)

				record.service.status.NextAttemptAt = nil
			} else {
				s.stopRetryTimerLocked(pluginID)

				// Past the retry cutoff the plugin stays failed, so a start request for the spec it ran with
				// is dropped. A changed spec stays: it settles when the run in flight ends, or went through the
				// changed-spec branch above when no run is in flight.
				if record.service.pending.spec.Equal(record.service.spec) {
					s.clearPendingStartLocked(record)
				}
			}
		} else {
			s.transitionFailureLocked(record, pluginID, "exited", err)
		}
	}

	effects = append(effects, s.settleAndAdmitLocked(pluginID)...)

	s.unlock()

	s.runEffects(effects)
}

func (s *Supervisor) pendingStartEligibleLocked(pluginID string, spec ServiceSpec, generation uint64) bool {
	plugin := s.plugins[pluginID]
	service := s.serviceRecordLocked(pluginID)
	transition := s.transitionRecordLocked(pluginID)

	return !s.shuttingDown && s.lifetimeCtx.Err() == nil && plugin != nil && plugin.desired != nil &&
		plugin.desired.Enabled && plugin.desired.Equal(spec) && service != nil && transition != nil &&
		transition.transition.intent == IntentRun && transition.transition.operation == OpNone &&
		s.transitionGenerationLocked(pluginID) == generation
}

// recordFailure advances status into backoff or, past the retry cutoff, failed.
// It is deterministic over status plus the injected now and reports whether
// the caller should schedule a retry and after what delay.
func recordFailure(status *RuntimeStatus, now time.Time, lastExit string, err error) (time.Duration, bool) {
	status.ConsecutiveFailures++
	status.LastExit = lastExit

	if err != nil {
		status.LastError = err.Error()
	}

	if status.ConsecutiveFailures >= maxConsecutiveFailures {
		status.State = StateFailed
		status.NextAttemptAt = nil

		return 0, false
	}

	delay := time.Second << (status.ConsecutiveFailures - 1)
	next := now.Add(delay)
	status.State = StateBackoff
	status.NextAttemptAt = &next

	return delay, true
}

func (s *Supervisor) transitionFailureLocked(record *pluginRecord, pluginID, lastExit string, err error) {
	delay, retry := recordFailure(&record.service.status, s.now(), lastExit, err)

	if retry {
		s.scheduleRetry(pluginID, delay)
	} else {
		s.stopRetryTimerLocked(pluginID)
	}
}

func (s *Supervisor) stopRetryTimerLocked(pluginID string) {
	record := s.plugins[pluginID]

	if record == nil {
		return
	}

	s.stopRetryTimerOnlyLocked(record)

	s.prunePluginRecordLocked(pluginID)
}

func (s *Supervisor) clearPendingStartLocked(record *pluginRecord) {
	if record.service != nil {
		record.service.pending = nil
	}
}

func (s *Supervisor) stopRetryTimerOnlyLocked(record *pluginRecord) {
	if record.service == nil || record.service.retry == nil {
		return
	}

	if record.service.retry.timer != nil {
		record.service.retry.timer.Stop()
	}

	record.service.retry = nil
}

func (s *Supervisor) stopRetryTimersLocked() {
	for pluginID, record := range s.plugins {
		s.stopRetryTimerLocked(pluginID)
		s.clearPendingStartLocked(record)
	}
}

func (s *Supervisor) scheduleRetry(pluginID string, delay time.Duration) {
	s.stopRetryTimerLocked(pluginID)

	if s.shuttingDown || s.lifetimeCtx.Err() != nil {
		return
	}

	record := s.ensurePluginRecordLocked(pluginID)
	plugin := s.plugins[pluginID]

	if plugin == nil || plugin.desired == nil || !plugin.desired.Enabled {
		return
	}

	retrySpec := *plugin.desired
	retrySpec.Args = append([]string(nil), plugin.desired.Args...)
	retryTargetGen := s.transitionGenerationLocked(pluginID)
	service := s.serviceRecordLocked(pluginID)

	if service == nil {
		return
	}

	state := &retryState{}
	state.timer = time.AfterFunc(delay, func() {
		if callbackDone := s.retryCallbackDone; callbackDone != nil {
			defer callbackDone(pluginID)
		}

		if callbackStarting := s.retryCallbackStarting; callbackStarting != nil {
			callbackStarting(pluginID)
		}

		s.mu.Lock()

		current := s.serviceRecordLocked(pluginID)

		if s.plugins[pluginID] != record || current == nil || current.service.retry != state {
			s.unlock()

			return
		}

		current.service.retry = nil

		if !s.pendingStartEligibleLocked(pluginID, retrySpec, retryTargetGen) {
			s.unlock()

			return
		}

		if current.service.proc != nil || current.service.stop != nil {
			s.markPendingStartLocked(record, retrySpec, true)

			s.unlock()

			return
		}

		if current.service.status.State != StateBackoff {
			s.unlock()

			return
		}

		effects := s.trackDesiredStartupLocked(retrySpec)

		s.unlock()

		s.runEffects(effects)
	})
	service.service.retry = state
}

// settleLocked decides whether the pending start may run now and returns effects for the caller to run after unlocking.
func (s *Supervisor) settleLocked(pluginID string) []effect {
	record := s.serviceRecordLocked(pluginID)
	plugin := s.plugins[pluginID]
	transition := s.transitionRecordLocked(pluginID)

	if record == nil || plugin == nil || transition == nil || record.service.pending == nil {
		return nil
	}

	if record.service.proc != nil || record.service.stop != nil || transition.transition.operation != OpNone {
		return nil
	}

	request := record.service.pending
	spec := request.spec

	if !s.pendingStartEligibleLocked(pluginID, spec, request.generation) {
		s.clearPendingStartLocked(record)

		return nil
	}

	if request.retry && record.service.status.State != StateBackoff {
		s.clearPendingStartLocked(record)

		return nil
	}

	if !record.service.spec.Equal(spec) && record.service.slot != slotNone {
		record.service.status.State = StateStopped
		record.service.status.NextAttemptAt = nil

		s.keepRestartSlotLocked(record, spec)
	}

	reserved, effects := s.reserveForReconcileLocked(spec)

	s.clearPendingStartLocked(record)

	if !reserved {
		return effects
	}

	record.service.status.NextAttemptAt = nil

	return append(effects, s.trackDesiredStartupLocked(spec)...)
}

func (s *Supervisor) stopRecord(ctx context.Context, pluginID string) error {
	return s.stopProcess(ctx, pluginID, stopRelease)
}

func (s *Supervisor) releaseUnstartedReservation(run *operationRun) (bool, []effect) {
	s.mu.Lock()

	defer s.unlock()

	return s.takeUnstartedReservationLocked(run)
}

// takeUnstartedReservationLocked gives an unclaimed reservation back and hands the slot to the first admissible
// plugin in the same critical section; the effects start it.
func (s *Supervisor) takeUnstartedReservationLocked(run *operationRun) (bool, []effect) {
	if !s.isCurrentLocked(run) {
		return false, nil
	}

	record := s.serviceRecordLocked(run.name)

	if record == nil || record.service.proc != nil || record.service.slot != slotReservedByReconcile {
		return false, nil
	}

	s.releaseServiceSlotLocked(record)

	if record.service.status.State == StateCapacityBlocked {
		record.service.status.State = StateStopped
		record.service.status.NextAttemptAt = nil
	}

	return true, s.admitLocked()
}

func (s *Supervisor) stopProcess(ctx context.Context, pluginID string, kind stopKind) error {
	if ctx == nil {
		ctx = context.Background()
	}

	for {
		s.mu.Lock()

		record := s.serviceRecordLocked(pluginID)

		if record == nil {
			s.unlock()

			return nil
		}

		if launch := record.service.launching(); launch != nil {
			launchDone := launch.done
			restartCount := record.service.status.RestartCount

			s.stopRetryTimerLocked(pluginID)

			if kind != stopKeep {
				record.service.status = RuntimeStatus{State: StateStopped, RestartCount: restartCount}

				record.service.claimSlot()
			}

			s.unlock()

			select {
			case <-launchDone:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		if record.service.stop != nil {
			stop := record.service.stop

			if kind != stopKeep {
				stop.kind = max(stop.kind, kind)
				restartCount := record.service.status.RestartCount
				record.service.status = RuntimeStatus{State: StateStopped, RestartCount: restartCount}

				record.service.claimSlot()
			}

			s.unlock()

			select {
			case <-stop.done:
				return stop.err
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		process, paths := record.service.process(), record.service.paths
		restartCount := record.service.status.RestartCount
		stop := &stopState{done: make(chan struct{}), kind: kind}
		record.service.stop = stop

		s.stopRetryTimerLocked(pluginID)

		if kind != stopKeep {
			record.service.status = RuntimeStatus{State: StateStopped, RestartCount: restartCount}

			record.service.claimSlot()
		}

		s.unlock()

		var stopErr error
		reaped := process == nil

		if process != nil {
			if process.command != nil && process.command.Process != nil {
				_ = terminateExecProcess(process.command.Process)
			}

			exited, waitErr := waitForProcessExitContext(ctx, process.exit.done, s.cfg.StopTimeout)
			reaped = exited

			if waitErr != nil {
				stopErr = errors.Join(stopErr, fmt.Errorf("stop service %q: %w", pluginID, waitErr))
			}

			if !exited {
				if process.command != nil && process.command.Process != nil {
					_ = killExecProcess(process.command.Process)
				}

				var reapErr error

				reaped, reapErr = waitForProcessReap(ctx, process.exit.done, s.cfg.FinalReapTimeout)

				if reapErr != nil {
					stopErr = errors.Join(stopErr, fmt.Errorf("reap service %q: %w", pluginID, reapErr))
				}

				if !reaped {
					stopErr = errors.Join(stopErr, fmt.Errorf("service %q did not exit after kill", pluginID))

					if process.command != nil && process.command.Process != nil {
						s.cfg.Logger.Warn("service did not exit after kill", "plugin", pluginID, "pid", process.command.Process.Pid)
					}
				}
			}
		}

		if !reaped {
			s.mu.Lock()

			if s.plugins[pluginID] == record && record.service.stop == stop {
				stop.err = stopErr
			}

			s.unlock()

			go s.finishStopAfterExit(pluginID, record, process, paths, stop)

			return stopErr
		}

		// The process is gone, so the stop is complete whatever happened to the caller's context while it waited. The
		// stop records what the finalizer would record, nil, so joiners and lastStopErr do not see the first caller's
		// context error; that caller still hears its own.
		return errors.Join(stopErr, s.finishStop(pluginID, record, process, paths, stop, nil))
	}
}

func (s *Supervisor) finishStopAfterExit(
	pluginID string,
	record *pluginRecord,
	process *registeredProcess,
	paths RuntimePaths,
	stop *stopState,
) {
	// One finalizer and retained record remain per never-exiting process until it or the daemon exits.
	if process != nil {
		<-process.exit.done
	}

	// Exact Wait completed, so a deferred reap timeout no longer makes stop incomplete.
	s.finishStop(pluginID, record, process, paths, stop, nil)
}

func (s *Supervisor) finishStop(
	pluginID string,
	record *pluginRecord,
	process *registeredProcess,
	paths RuntimePaths,
	stop *stopState,
	stopErr error,
) error {
	if err := removeRuntimeEvidence(paths); err != nil {
		stopErr = errors.Join(stopErr, err)
	}

	s.mu.Lock()

	ownsProcess := record.service.process() == process

	if s.plugins[pluginID] != record || record.service.stop != stop || !ownsProcess {
		s.unlock()

		return stopErr
	}

	releaseSlot := stop.kind == stopRelease

	if process != nil {
		record.service.proc = nil
	}

	if releaseSlot {
		s.releaseServiceSlotLocked(record)

		record.service.claimSlot()
	}

	stop.err = stopErr
	record.service.lastStopErr = stopErr
	record.service.stop = nil

	close(stop.done)

	effects := s.settleAndAdmitLocked(pluginID)

	s.unlock()

	s.runEffects(effects)

	return stopErr
}

func ptrTime(value time.Time) *time.Time { return &value }
