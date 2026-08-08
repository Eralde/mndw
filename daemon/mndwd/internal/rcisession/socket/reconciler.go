package socket

import (
	"context"
	"fmt"
	"sync"
)

type Binding struct {
	PluginID              string
	Path                  string
	CredentialIndependent bool
}

type Reconciler struct {
	config  Config
	handler Handler

	mu      sync.Mutex
	servers map[string]*Server
}

func NewReconciler(config Config, handler Handler) *Reconciler {
	return &Reconciler{config: config, handler: handler, servers: make(map[string]*Server)}
}

func (r *Reconciler) Reconcile(ctx context.Context, bindings []Binding, sessionPresent bool) error {
	if r.handler == nil {
		return fmt.Errorf("socket reconciler handler is required")
	}
	desired := make(map[string]Binding)
	for _, binding := range bindings {
		if binding.PluginID != "" && binding.Path != "" && (sessionPresent || binding.CredentialIndependent) {
			desired[binding.PluginID] = binding
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
			continue
		}
		_ = server.Close()
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
			if r.config.Logger != nil {
				r.config.Logger.Error("persistent RCI socket start failed", "plugin", pluginID, "path", binding.Path, "reason", "listen-failed")
			}
			return err
		}
		r.mu.Lock()
		r.servers[pluginID] = server
		r.mu.Unlock()
	}
	return nil
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
