package backend

// ActivationBlocker is a machine-readable reason a declared activation
// permission is not currently available.
type ActivationBlocker struct {
	Permission   string
	Reason       string
	Prerequisite string
}

// ActivationGate evaluates one declared permission for one plugin.
type ActivationGate interface {
	Evaluate(pluginName, permission string) []ActivationBlocker
}

// ActivationGateFunc adapts a function to ActivationGate.
type ActivationGateFunc func(pluginName, permission string) []ActivationBlocker

func (f ActivationGateFunc) Evaluate(pluginName, permission string) []ActivationBlocker {
	return f(pluginName, permission)
}

// ActivationGateRegistry maps manifest permission IDs to their activation
// predicates. It is assembled before runtime use and then treated as read-only.
type ActivationGateRegistry struct {
	gates map[string]ActivationGate
}

func NewActivationGateRegistry() *ActivationGateRegistry {
	return &ActivationGateRegistry{gates: make(map[string]ActivationGate)}
}

func (r *ActivationGateRegistry) Register(permissionID string, gate ActivationGate) {
	if r == nil || gate == nil {
		return
	}

	if r.gates == nil {
		r.gates = make(map[string]ActivationGate)
	}

	r.gates[permissionID] = gate
}

func (r *ActivationGateRegistry) Lookup(permissionID string) (ActivationGate, bool) {
	if r == nil {
		return nil, false
	}

	gate, ok := r.gates[permissionID]

	return gate, ok
}

// Evaluate returns active blockers in manifest permission order, retaining only
// the first instance of each blocker tuple.
func (r *ActivationGateRegistry) Evaluate(pluginName string, permissions []string) []ActivationBlocker {
	if r == nil {
		return nil
	}

	blockers := make([]ActivationBlocker, 0)
	seen := make(map[activationBlockerKey]struct{})

	for _, permission := range permissions {
		gate, ok := r.Lookup(permission)

		if !ok {
			continue
		}

		for _, blocker := range gate.Evaluate(pluginName, permission) {
			key := activationBlockerKey{
				permission:   blocker.Permission,
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

func (r *ActivationGateRegistry) Satisfied(pluginName string, permissions []string) bool {
	return len(r.Evaluate(pluginName, permissions)) == 0
}

type activationBlockerKey struct {
	permission   string
	reason       string
	prerequisite string
}
