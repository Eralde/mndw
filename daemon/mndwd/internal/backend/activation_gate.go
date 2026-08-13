package backend

// ActivationGate reports whether a plugin's declared activation condition is
// currently satisfied.
type ActivationGate interface {
	Satisfied(pluginName string) bool
}

// ActivationGateFunc adapts a function to ActivationGate.
type ActivationGateFunc func(pluginName string) bool

func (f ActivationGateFunc) Satisfied(pluginName string) bool {
	return f(pluginName)
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
