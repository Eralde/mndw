package backend

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// RuntimeLimitsSnapshot is the public, command-free capacity view used by
// management and diagnostics. It intentionally contains no process identity or
// socket information.
type RuntimeLimitsSnapshot struct {
	MaxConcurrentExecTotal     int   `json:"maxConcurrentExecTotal"`
	MaxConcurrentExecPerPlugin int   `json:"maxConcurrentExecPerPlugin"`
	MaxSupervisedServices      int   `json:"maxSupervisedServices"`
	CurrentExec                int   `json:"currentExec"`
	ReservedServices           int   `json:"reservedServices"`
	SupportedServiceProtocols  []int `json:"supportedServiceProtocols"`
}

// Runtime is the lifecycle facade shared by the gateway, management, and
// daemon startup/shutdown paths.
type Runtime interface {
	Reconcile(context.Context, []*registry.Plugin)
	ExecuteLifecycle(string, Operation, Intent, func(context.Context, LifecycleControl) error) error
	BlocksTraffic(string) bool
	Status(string) RuntimeStatus
	Limits() RuntimeLimitsSnapshot
	BeginPlatformMaintenance(context.Context) error
	Shutdown(context.Context) error
}

type RuntimeConfig struct {
	RuntimeRoot               string
	PluginDataRoot            string
	Limits                    Limits
	SupportedServiceProtocols []int
	ActivationGates           *ActivationGateRegistry
	Exec                      ExecRunnerConfig
	Supervisor                SupervisorConfig
	OnLifecycle               LifecycleObserver
}

type LifecycleEvent struct {
	Plugin string
	State  LifecycleState
	Reason LifecycleReason
}

type LifecycleObserver func(LifecycleEvent)

// RuntimeImpl owns one admission ledger for both request-scoped commands and
// long-running services. This prevents separate subsystems from exceeding a
// shared platform limit during startup or shutdown races.
type RuntimeImpl struct {
	exec              *ExecRunner
	supervisor        *Supervisor
	traffic           *TrafficGate
	limits            Limits
	protocols         []int
	now               func() time.Time
	logger            *slog.Logger
	runtimeRoot       string
	activationGates   *ActivationGateRegistry
	lifecycleObserver LifecycleObserver
}

func NewRuntime(config RuntimeConfig) *RuntimeImpl {
	if config.RuntimeRoot == "" {
		config.RuntimeRoot = "/opt/tmp/mndw/plugin-runtime"
	}

	defaults := DefaultLimits()

	if config.Limits.MaxConcurrentExecTotal <= 0 {
		config.Limits.MaxConcurrentExecTotal = defaults.MaxConcurrentExecTotal
	}

	if config.Limits.MaxConcurrentExecPerPlugin <= 0 {
		config.Limits.MaxConcurrentExecPerPlugin = defaults.MaxConcurrentExecPerPlugin
	}

	if config.Limits.MaxSupervisedServices <= 0 {
		config.Limits.MaxSupervisedServices = defaults.MaxSupervisedServices
	}

	if len(config.SupportedServiceProtocols) == 0 {
		config.SupportedServiceProtocols = []int{1}
	}

	if config.ActivationGates == nil {
		config.ActivationGates = NewActivationGateRegistry()
	}

	if config.OnLifecycle == nil {
		config.OnLifecycle = func(LifecycleEvent) {}
	}

	config.Exec.MaxConcurrentExecTotal = config.Limits.MaxConcurrentExecTotal
	config.Exec.MaxConcurrentExecPerPlugin = config.Limits.MaxConcurrentExecPerPlugin
	config.Exec.RuntimeRoot = config.RuntimeRoot
	config.Exec.PluginDataRoot = config.PluginDataRoot

	if config.Supervisor.RuntimeRoot == "" {
		config.Supervisor.RuntimeRoot = config.RuntimeRoot
	}

	config.Supervisor.PluginDataRoot = config.PluginDataRoot
	config.Supervisor.Limits = config.Limits
	config.Supervisor.SupportedProtocols = append([]int(nil), config.SupportedServiceProtocols...)
	config.Supervisor = normalizeSupervisorConfig(config.Supervisor)

	admission := NewAdmission(config.Limits)

	runtime := &RuntimeImpl{
		exec:              newExecRunner(config.Exec, admission),
		supervisor:        newSupervisor(config.Supervisor, admission),
		traffic:           NewTrafficGate(),
		limits:            config.Limits,
		protocols:         append([]int(nil), config.SupportedServiceProtocols...),
		now:               config.Supervisor.Now,
		logger:            config.Supervisor.Logger,
		runtimeRoot:       config.RuntimeRoot,
		activationGates:   config.ActivationGates,
		lifecycleObserver: config.OnLifecycle,
	}
	runtime.supervisor.startDesired = runtime.executeDesiredStartup

	return runtime
}

func (r *RuntimeImpl) Reconcile(ctx context.Context, plugins []*registry.Plugin) {
	specs := make([]ServiceSpec, 0, len(plugins))
	pluginsByID := make(map[string]*registry.Plugin, len(plugins))

	for _, plugin := range plugins {
		if spec, ok := r.serviceSpec(plugin); ok {
			specs = append(specs, spec)
			pluginsByID[plugin.Name] = plugin
		}
	}

	plan := r.supervisor.Reconcile(ctx, specs)

	for _, pluginID := range plan.startIDs {
		plugin := pluginsByID[pluginID]

		if plugin != nil {
			go r.executeStartup(plugin)
		}
	}

	for _, pluginID := range plan.stopIDs {
		go r.executeReconcileStop(pluginID, false)
	}

	for _, pluginID := range plan.removeIDs {
		go r.executeReconcileStop(pluginID, true)
	}
}

func (r *RuntimeImpl) executeStartup(plugin *registry.Plugin) {
	spec, ok := r.serviceSpec(plugin)

	if !ok {
		return
	}

	outcome := r.supervisor.beginDesiredStartup(spec)
	err := r.executeLifecycleOutcome(plugin.Name, OpStarting,
		func(_ context.Context, control LifecycleControl) error { return control.StartPlugin(plugin) }, outcome)

	if err != nil && !errors.Is(err, errSuperseded) && !errors.Is(err, ErrLifecycleConflict) && r.logger != nil {
		r.logger.Warn("service start deferred", "plugin", plugin.Name, "error", err)
	}
}

func (r *RuntimeImpl) executeDesiredStartup(spec ServiceSpec) {
	outcome := r.supervisor.beginDesiredStartup(spec)
	err := r.executeLifecycleOutcome(spec.PluginID, OpStarting,
		func(_ context.Context, control LifecycleControl) error {
			concrete, ok := control.(*lifecycleControl)

			if !ok || !concrete.IsCurrent() {
				return errSuperseded
			}

			return r.supervisor.startService(concrete.run, spec)
		}, outcome)

	if err != nil && !errors.Is(err, errSuperseded) && !errors.Is(err, ErrLifecycleConflict) && r.logger != nil {
		r.logger.Warn("service retry deferred", "plugin", spec.PluginID, "error", err)
	}
}

func (r *RuntimeImpl) executeReconcileStop(pluginID string, remove bool) {
	op := OpStopping
	intent := IntentStop

	if remove {
		op = OpDeleting
		intent = IntentRemove
	}

	err := r.ExecuteLifecycle(pluginID, op, intent,
		func(_ context.Context, control LifecycleControl) error { return control.StopService() })

	if err != nil && !errors.Is(err, errSuperseded) && !errors.Is(err, ErrLifecycleConflict) && r.logger != nil {
		r.logger.Warn("service stop deferred", "plugin", pluginID, "error", err)
	}
}

func (r *RuntimeImpl) Status(pluginID string) RuntimeStatus {
	return r.supervisor.Status(pluginID)
}

func (r *RuntimeImpl) Limits() RuntimeLimitsSnapshot {
	execTotal, services, _ := r.supervisor.admission.Snapshot()

	return RuntimeLimitsSnapshot{
		MaxConcurrentExecTotal:     r.limits.MaxConcurrentExecTotal,
		MaxConcurrentExecPerPlugin: r.limits.MaxConcurrentExecPerPlugin,
		MaxSupervisedServices:      r.limits.MaxSupervisedServices,
		CurrentExec:                execTotal,
		ReservedServices:           services,
		SupportedServiceProtocols:  append([]int(nil), r.protocols...),
	}
}

func (r *RuntimeImpl) BeginPlatformMaintenance(ctx context.Context) error {
	r.traffic.BeginPlatformMaintenance()

	return r.supervisor.StopAll(ctx)
}

func (r *RuntimeImpl) Shutdown(ctx context.Context) error {
	r.traffic.BeginPlatformMaintenance()

	pluginIDs := r.supervisor.runningPluginIDs()
	err := r.supervisor.StopAll(ctx)
	if err == nil {
		for _, pluginID := range pluginIDs {
			r.lifecycleObserver(LifecycleEvent{Plugin: pluginID, State: LifecycleStopped, Reason: LifecycleReasonShutdown})
		}
	}

	return err
}
func (r *RuntimeImpl) serviceSpec(plugin *registry.Plugin) (ServiceSpec, bool) {
	spec, ok := serviceSpec(plugin, r.activationGates)

	if !ok {
		return ServiceSpec{}, false
	}

	spec.RCISessionSocket = persistentRCISocket(r.runtimeRoot, plugin)

	return spec, true
}

func (r *RuntimeImpl) Traffic() *TrafficGate { return r.traffic }

func (r *RuntimeImpl) Now() time.Time { return r.now() }

func (r *RuntimeImpl) SocketPath(pluginID string) (string, bool) {
	return r.supervisor.SocketPath(pluginID)
}

func (r *RuntimeImpl) SupportsProtocol(protocol int) bool {
	return r.supervisor.SupportsProtocol(protocol)
}

func (r *RuntimeImpl) SupportedProtocols() []int {
	return r.supervisor.SupportedProtocols()
}

func (r *RuntimeImpl) ServeExec(ctx context.Context, request ExecRequest, writer http.ResponseWriter) *httpx.APIError {
	request.RuntimeDir = runtimeDir(r.exec, request.PluginID)

	return r.exec.Serve(ctx, request, writer)
}

func runtimeDir(runner *ExecRunner, pluginID string) string {
	if runner == nil || runner.cfg.RuntimeRoot == "" {
		return ""
	}

	paths, err := NewRuntimePaths(runner.cfg.RuntimeRoot, pluginID)
	if err != nil {
		return ""
	}

	if err := paths.Ensure(); err != nil {
		return ""
	}

	return paths.PluginDir
}

// LiveDiagnostics exposes only the bounded service callback used by support
// diagnostics; service paths and process identity stay inside the backend.
func (r *RuntimeImpl) LiveDiagnostics(ctx context.Context, pluginID string) ([]byte, error) {
	return r.supervisor.LiveDiagnostics(ctx, pluginID)
}

func serviceSpec(plugin *registry.Plugin, gates *ActivationGateRegistry) (ServiceSpec, bool) {
	if plugin == nil || plugin.Manifest == nil || plugin.Manifest.Backend == nil {
		return ServiceSpec{}, false
	}

	backend := plugin.Manifest.Backend

	if backend.Kind == nil || *backend.Kind != manifest.BackendKindService || backend.Command == nil {
		return ServiceSpec{}, false
	}

	protocolVersion := 1

	if backend.ProtocolVersion != nil {
		protocolVersion = *backend.ProtocolVersion
	}

	enabled := plugin.Enabled && plugin.Approval == state.ApprovalApproved && !plugin.RemovalPending

	if enabled && gates != nil {
		enabled = gates.Satisfied(plugin.Name, plugin.Manifest.Permissions)
	}

	return ServiceSpec{
		PluginID:        plugin.Name,
		Dir:             plugin.Dir,
		Command:         *backend.Command,
		Args:            append([]string(nil), backend.Args...),
		ProtocolVersion: protocolVersion,
		Builtin:         plugin.Source == state.SourceBuiltin,
		Enabled:         enabled,
		RemovalPending:  plugin.RemovalPending,
	}, true
}

func persistentRCISocket(runtimeRoot string, plugin *registry.Plugin) string {
	if plugin == nil || plugin.Manifest == nil {
		return ""
	}

	for _, permission := range plugin.Manifest.Permissions {
		if manifest.IsPersistentRCIPermission(permission) {
			paths, err := NewRuntimePaths(runtimeRoot, plugin.Name)
			if err == nil {
				return paths.RCISessionSocket
			}
		}
	}

	return ""
}

// RuntimePathExists is a small startup helper kept here so callers can avoid
// probing or creating arbitrary paths when runtime root is unavailable.
func RuntimePathExists(root string) bool {
	_, err := os.Stat(root)

	return err == nil
}
