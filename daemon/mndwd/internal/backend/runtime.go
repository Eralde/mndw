package backend

import (
	"context"
	"os"
	"time"

	"mndwd/internal/manifest"
	"mndwd/internal/registry"
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
	Activate(context.Context, *registry.Plugin) error
	Deactivate(context.Context, string, StopReason) error
	Restart(context.Context, string) error
	Status(string) RuntimeStatus
	Limits() RuntimeLimitsSnapshot
	BeginPluginMaintenance(context.Context, string) error
	EndPluginMaintenance(string)
	BeginPlatformMaintenance(context.Context) error
	Shutdown(context.Context) error
}

type RuntimeConfig struct {
	RuntimeRoot               string
	PluginDataRoot            string
	Limits                    Limits
	SupportedServiceProtocols []int
	Exec                      ExecRunnerConfig
	Supervisor                SupervisorConfig
}

// RuntimeImpl owns one admission ledger for both request-scoped commands and
// long-running services. This prevents separate subsystems from exceeding a
// shared platform limit during startup or shutdown races.
type RuntimeImpl struct {
	exec           *ExecRunner
	supervisor     *Supervisor
	limits         Limits
	protocols      []int
	runtimeRoot    string
	maintenance    func(string)
	maintenanceEnd func(string)
	platform       func()
}

func NewRuntime(config RuntimeConfig) *RuntimeImpl {
	if config.RuntimeRoot == "" {
		config.RuntimeRoot = "/opt/tmp/mndw/plugin-runtime"
	}

	if config.Limits.MaxConcurrentExecTotal <= 0 {
		config.Limits.MaxConcurrentExecTotal = 8
	}

	if config.Limits.MaxConcurrentExecPerPlugin <= 0 {
		config.Limits.MaxConcurrentExecPerPlugin = 4
	}

	if config.Limits.MaxSupervisedServices <= 0 {
		config.Limits.MaxSupervisedServices = 8
	}

	if len(config.SupportedServiceProtocols) == 0 {
		config.SupportedServiceProtocols = []int{1}
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
	config.Supervisor.ReadinessTimeout = positiveDuration(config.Supervisor.ReadinessTimeout, 30*time.Second)
	config.Supervisor.StopTimeout = positiveDuration(config.Supervisor.StopTimeout, 10*time.Second)
	config.Supervisor.FinalReapTimeout = positiveDuration(config.Supervisor.FinalReapTimeout, 2*time.Second)

	admission := NewAdmission(config.Limits)

	return &RuntimeImpl{
		exec:        newExecRunner(config.Exec, admission),
		supervisor:  newSupervisor(config.Supervisor, admission),
		limits:      config.Limits,
		protocols:   append([]int(nil), config.SupportedServiceProtocols...),
		runtimeRoot: config.RuntimeRoot,
	}
}

func positiveDuration(value, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}

	return value
}

func (r *RuntimeImpl) Reconcile(ctx context.Context, plugins []*registry.Plugin) {
	specs := make([]ServiceSpec, 0, len(plugins))

	for _, plugin := range plugins {
		if spec, ok := serviceSpec(plugin); ok {
			spec.RCISessionSocket = persistentRCISocket(r.runtimeRoot, plugin)
			specs = append(specs, spec)
		}
	}

	r.supervisor.Reconcile(ctx, specs)
}

func (r *RuntimeImpl) Activate(ctx context.Context, plugin *registry.Plugin) error {
	spec, ok := serviceSpec(plugin)

	if !ok {
		return nil
	}

	spec.RCISessionSocket = persistentRCISocket(r.runtimeRoot, plugin)

	return r.supervisor.Start(ctx, spec)
}

func (r *RuntimeImpl) Deactivate(ctx context.Context, pluginID string, reason StopReason) error {
	return r.supervisor.Forget(ctx, pluginID, reason)
}

func (r *RuntimeImpl) Restart(ctx context.Context, pluginID string) error {
	return r.supervisor.Restart(ctx, pluginID)
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

func (r *RuntimeImpl) BeginPluginMaintenance(ctx context.Context, pluginID string) error {
	if r.maintenance != nil {
		r.maintenance(pluginID)
	}

	return r.supervisor.Forget(ctx, pluginID, StopMaintenance)
}

func (r *RuntimeImpl) BeginPlatformMaintenance(ctx context.Context) error {
	if r.platform != nil {
		r.platform()
	}

	return r.supervisor.StopAll(ctx, StopMaintenance)
}

func (r *RuntimeImpl) EndPluginMaintenance(pluginID string) {
	if r.maintenanceEnd != nil {
		r.maintenanceEnd(pluginID)
	}
}

func (r *RuntimeImpl) Shutdown(ctx context.Context) error {
	if r.platform != nil {
		r.platform()
	}

	return r.supervisor.StopAll(ctx, StopShutdown)
}

func (r *RuntimeImpl) SetMaintenanceHooks(plugin func(string), platform func(), endPlugin func(string)) {
	r.maintenance = plugin
	r.platform = platform
	r.maintenanceEnd = endPlugin
}

// ExecRunner exposes request execution to the v3 gateway without exposing its
// admission internals.
func (r *RuntimeImpl) ExecRunner() *ExecRunner { return r.exec }

// Supervisor exposes readiness/socket state to the v3 gateway.
func (r *RuntimeImpl) Supervisor() *Supervisor { return r.supervisor }

// LiveDiagnostics exposes only the bounded service callback used by support
// diagnostics; service paths and process identity stay inside the backend.
func (r *RuntimeImpl) LiveDiagnostics(ctx context.Context, pluginID string) ([]byte, error) {
	return r.supervisor.LiveDiagnostics(ctx, pluginID)
}

func serviceSpec(plugin *registry.Plugin) (ServiceSpec, bool) {
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

	return ServiceSpec{
		PluginID:        plugin.Name,
		Dir:             plugin.Dir,
		Command:         *backend.Command,
		Args:            append([]string(nil), backend.Args...),
		ProtocolVersion: protocolVersion,
		Builtin:         plugin.Source == "builtin",
		Enabled:         plugin.Enabled && plugin.Approval == "approved",
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
