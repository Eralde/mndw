package socket

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

type Binding struct {
	PluginID string
	Path     string
}

type ReconcileReport struct {
	Desired     map[string]bool
	Active      map[string]bool
	StartErrors map[string]error
}

type Reconciler struct {
	config  Config
	handler Handler

	mu      sync.Mutex
	servers map[string]*Server
}

func NewReconciler(config Config, handler Handler) *Reconciler {
	if config.DrainTimeout <= 0 {
		config.DrainTimeout = DefaultDrainTimeout
	}

	return &Reconciler{config: config, handler: handler, servers: make(map[string]*Server)}
}

var ErrDrainTimeout = errors.New("persistent RCI socket drain timed out")

func (r *Reconciler) Reconcile(ctx context.Context, bindings []Binding, sessionPresent bool) (ReconcileReport, error) {
	report := ReconcileReport{
		Desired:     make(map[string]bool),
		Active:      make(map[string]bool),
		StartErrors: make(map[string]error),
	}
	if r.handler == nil {
		return report, fmt.Errorf("socket reconciler handler is required")
	}
	seen := make(map[string]struct{}, len(bindings))
	for _, binding := range bindings {
		if binding.PluginID == "" {
			return report, fmt.Errorf("socket binding plugin ID is required")
		}
		if _, exists := seen[binding.PluginID]; exists {
			return report, fmt.Errorf("duplicate socket binding plugin ID: %s", binding.PluginID)
		}
		seen[binding.PluginID] = struct{}{}
	}
	desired := make(map[string]Binding)
	for _, binding := range bindings {
		if binding.Path != "" && sessionPresent {
			desired[binding.PluginID] = binding
			report.Desired[binding.PluginID] = true
		}
	}
	r.mu.Lock()
	current := make(map[string]*Server, len(r.servers))
	for pluginID, server := range r.servers {
		current[pluginID] = server
	}
	r.mu.Unlock()
	for pluginID, server := range current {
		if _, keep := desired[pluginID]; keep {
			report.Active[pluginID] = true
			continue
		}
		if err := server.Close(); err != nil && r.config.Logger != nil {
			r.config.Logger.Warn("persistent RCI socket close failed", "plugin", pluginID, "reason", "reconcile")
		}
		if r.config.Logger != nil {
			r.config.Logger.Info("persistent RCI socket binding removed", "plugin", pluginID, "reason", "reconcile")
		}
		r.mu.Lock()
		delete(r.servers, pluginID)
		r.mu.Unlock()
	}
	for pluginID, binding := range desired {
		if _, exists := current[pluginID]; exists {
			continue
		}
		config := r.config
		config.PluginID = pluginID
		config.Allowed = true
		server := NewServer(binding.Path, config, r.handler)
		if err := server.Start(ctx); err != nil {
			report.StartErrors[pluginID] = err
			if r.config.Logger != nil {
				r.config.Logger.Error("persistent RCI socket start failed", "plugin", pluginID, "reason", "listen-failed")
			}
			continue
		}
		r.mu.Lock()
		r.servers[pluginID] = server
		r.mu.Unlock()
		report.Active[pluginID] = true
	}
	return report, nil
}

func (r *Reconciler) Close() {
	r.mu.Lock()
	servers := make([]*Server, 0, len(r.servers))
	for _, server := range r.servers {
		servers = append(servers, server)
	}
	r.servers = make(map[string]*Server)
	r.mu.Unlock()
	for _, server := range servers {
		_ = server.Close()
	}
}
