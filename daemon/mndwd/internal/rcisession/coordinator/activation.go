package coordinator

import (
	"mndwd/internal/backend"
	"mndwd/internal/manifest"
)

// RegisterActivationGates makes gates consult this coordinator for both
// persistent-RCI capabilities.
func (c *Coordinator) RegisterActivationGates(gates *backend.ActivationGateRegistry) {
	if gates == nil {
		return
	}

	gate := backend.ActivationGate(c.ActivationBlockers)

	gates.Register(manifest.PersistentRCISessionReadCapability, gate)
	gates.Register(manifest.PersistentRCISessionWriteCapability, gate)
}

type activationSnapshot struct {
	grants          map[string]activationGrantFacts
	controllerToken bool
}

type activationGrantFacts struct {
	read  bool
	write bool
}

func (c *Coordinator) ActivationBlockers(pluginName, capability string) []backend.ActivationBlocker {
	if capability != manifest.PersistentRCISessionReadCapability && capability != manifest.PersistentRCISessionWriteCapability {
		return nil
	}

	snapshot := c.activation.Load()

	if snapshot == nil {
		return []backend.ActivationBlocker{
			{Capability: capability, Reason: backend.BlockerNotGranted},
			{Capability: capability, Reason: backend.BlockerPrerequisiteUnavailable, Prerequisite: "controller-token"},
		}
	}

	facts := snapshot.grants[pluginName]
	grant := facts.read || facts.write

	if capability == manifest.PersistentRCISessionWriteCapability {
		grant = facts.write
	}

	blockers := make([]backend.ActivationBlocker, 0, 2)

	if !grant {
		blockers = append(blockers, backend.ActivationBlocker{Capability: capability, Reason: backend.BlockerNotGranted})
	}

	if !snapshot.controllerToken {
		blockers = append(blockers, backend.ActivationBlocker{
			Capability:   capability,
			Reason:       backend.BlockerPrerequisiteUnavailable,
			Prerequisite: "controller-token",
		})
	}

	return blockers
}

func (c *Coordinator) publishActivationSnapshotLocked(present bool) bool {
	next := make(map[string]activationGrantFacts)

	for _, plugin := range c.registry.AllBackendPlugins() {
		read := c.store.HasCapabilityGrant(plugin.Name, manifest.PersistentRCISessionReadCapability)
		write := c.store.HasCapabilityGrant(plugin.Name, manifest.PersistentRCISessionWriteCapability)
		next[plugin.Name] = activationGrantFacts{read: read, write: write}
	}

	previous := c.activation.Load()
	changed := previous == nil || previous.controllerToken != present || !sameActivationSnapshot(previous.grants, next)

	c.activation.Store(&activationSnapshot{grants: next, controllerToken: present})

	return changed
}

func sameActivationSnapshot(previous, next map[string]activationGrantFacts) bool {
	if len(previous) != len(next) {
		return false
	}

	for pluginName, facts := range previous {
		nextFacts, ok := next[pluginName]

		if !ok || nextFacts != facts {
			return false
		}
	}

	return true
}
