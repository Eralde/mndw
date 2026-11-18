package backend

// ActivationBlocker is a machine-readable reason a declared activation
// capability is not currently available.
type ActivationBlocker struct {
	Capability   string
	Reason       BlockerReason
	Prerequisite string
}

// ActivationGate evaluates one declared capability for one plugin.
type ActivationGate func(pluginName, capability string) []ActivationBlocker

// ActivationGateRegistry maps manifest capability IDs to their activation
// predicates. It is assembled before runtime use and then treated as read-only.
type ActivationGateRegistry struct {
	gates map[string]ActivationGate
}

func NewActivationGateRegistry() *ActivationGateRegistry {
	return &ActivationGateRegistry{gates: make(map[string]ActivationGate)}
}

func (r *ActivationGateRegistry) Register(capabilityID string, gate ActivationGate) {
	if r == nil || gate == nil {
		return
	}

	if r.gates == nil {
		r.gates = make(map[string]ActivationGate)
	}

	r.gates[capabilityID] = gate
}

func (r *ActivationGateRegistry) Lookup(capabilityID string) (ActivationGate, bool) {
	if r == nil {
		return nil, false
	}

	gate, ok := r.gates[capabilityID]

	return gate, ok
}

// Evaluate returns active blockers in manifest capability order, retaining only
// the first instance of each blocker tuple.
func (r *ActivationGateRegistry) Evaluate(pluginName string, capabilities []string) []ActivationBlocker {
	if r == nil {
		return nil
	}

	blockers := make([]ActivationBlocker, 0)
	seen := make(map[activationBlockerKey]struct{})

	for _, capability := range capabilities {
		gate, ok := r.Lookup(capability)

		if !ok {
			continue
		}

		for _, blocker := range gate(pluginName, capability) {
			key := activationBlockerKey{
				capability:   blocker.Capability,
				reason:       blocker.Reason,
				prerequisite: blocker.Prerequisite,
			}

			if _, ok := seen[key]; ok {
				continue
			}

			seen[key] = struct{}{}
			blockers = append(blockers, blocker)
		}
	}

	return blockers
}

func (r *ActivationGateRegistry) Satisfied(pluginName string, capabilities []string) bool {
	return len(r.Evaluate(pluginName, capabilities)) == 0
}

type activationBlockerKey struct {
	capability   string
	reason       BlockerReason
	prerequisite string
}
