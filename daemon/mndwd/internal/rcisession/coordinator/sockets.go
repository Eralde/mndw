package coordinator

import (
	"context"
	"fmt"
	"log/slog"

	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession/model"
	rcisessionsocket "mndwd/internal/rcisession/socket"
)

func (c *Coordinator) ReconcileSockets() {
	c.reconcileSockets(true)
}

func (c *Coordinator) reconcileSockets(pokeActivation bool) {
	c.mu.Lock()

	report, changed, err := c.reconcileSocketsLocked()
	poke := c.activationPoke

	c.mu.Unlock()

	if err != nil {
		c.serviceLogger().Error("persistent RCI socket reconciliation failed", "reason", "reconcile", "error", err)
	}

	for plugin := range report.StartErrors {
		c.serviceLogger().Error("persistent RCI socket start failed", "plugin", plugin, "reason", "reconcile")
	}

	if pokeActivation && changed && poke != nil {
		poke()
	}
}

func (c *Coordinator) ControllerPermissionAvailable() bool {
	if c == nil || c.service == nil {
		return false
	}

	return c.service.ControllerSupport() == model.SupportSupported
}

func (c *Coordinator) PermissionChanged(plugin string) error {
	if c == nil || c.service == nil || c.reconciler == nil {
		return nil
	}

	c.mu.Lock()

	report, changed, err := c.reconcileSocketsLocked()
	poke := c.activationPoke
	available := report.Desired[plugin] && !report.Active[plugin]

	c.mu.Unlock()

	if changed && poke != nil {
		poke()
	}

	if err != nil {
		return err
	}

	if available {
		return fmt.Errorf("%w: plugin %s socket unavailable", mgmt.ErrPersistentRCISocketStart, plugin)
	}

	return nil
}

func (c *Coordinator) reconcileSocketsLocked() (rcisessionsocket.ReconcileReport, bool, error) {
	bindings := make([]rcisessionsocket.Binding, 0)

	for _, plugin := range c.registry.AllBackendPlugins() {
		if !hasPersistentRCIPermission(plugin.Manifest) {
			continue
		}

		if !isService(plugin.Manifest) {
			continue
		}

		grants := rcisessionsocket.Grants{
			CanRead:  c.store.HasGrant(plugin.Name, manifest.PersistentRCISessionReadPermission),
			CanWrite: c.store.HasGrant(plugin.Name, manifest.PersistentRCISessionWritePermission),
		}
		grants.CanRead = grants.CanRead || grants.CanWrite

		if !grants.CanRead && !grants.CanWrite {
			continue
		}

		paths, err := backend.NewRuntimePaths(c.runtimeRoot, plugin.Name)
		if err == nil && paths.RCISessionSocket != "" {
			bindings = append(bindings, rcisessionsocket.Binding{
				PluginID: plugin.Name,
				Path:     paths.RCISessionSocket,
				Grants:   grants,
			})
		}
	}

	present := c.service.SessionPresent()

	report, err := c.reconciler.Reconcile(context.Background(), bindings, present)
	changed := c.publishActivationSnapshotLocked(present)

	return report, changed, err
}

func (c *Coordinator) serviceLogger() *slog.Logger {
	if c.logger != nil {
		return c.logger
	}

	return slog.Default()
}

func isService(m *manifest.Manifest) bool {
	return m != nil && m.Backend != nil && m.Backend.Kind != nil && *m.Backend.Kind == manifest.BackendKindService && m.Backend.ProtocolVersion != nil && *m.Backend.ProtocolVersion == 1
}

func hasPersistentRCIPermission(m *manifest.Manifest) bool {
	if m == nil {
		return false
	}

	for _, permission := range m.Permissions {
		if manifest.IsPersistentRCIPermission(permission) {
			return true
		}
	}

	return false
}
