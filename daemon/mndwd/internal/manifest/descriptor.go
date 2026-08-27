package manifest

// RouteDescriptor is the command-free host projection. Runtime command paths,
// service args, package requirements, and socket/process state never cross this
// boundary.
type RouteDescriptor struct {
	Transport string   `json:"transport"`
	Path      string   `json:"path"`
	Method    string   `json:"method,omitempty"`
	Protocols []string `json:"protocols,omitempty"`
}

// BackendDescriptor is the client-facing capability snapshot surfaced in
// GET /api/mgmt/list, minus approval/enabled state which the mgmt layer overlays
// from state.json. It also drives the approval UI capability display.
type BackendDescriptor struct {
	Routes map[string]RouteDescriptor `json:"routes"`
}

// Descriptor derives the client-facing backend capability snapshot from the
// manifest. Returns nil when the plugin declares no backend.
func Descriptor(m *Manifest) *BackendDescriptor {
	if m == nil {
		return &BackendDescriptor{Routes: map[string]RouteDescriptor{}}
	}

	if m.Backend == nil {
		return &BackendDescriptor{Routes: map[string]RouteDescriptor{}}
	}

	b := m.Backend
	routes := make(map[string]RouteDescriptor)

	for _, route := range b.Routes {
		routes[route.ID] = RouteDescriptor{
			Transport: route.Transport,
			Path:      route.Path,
			Method:    route.Method,
			Protocols: route.Protocols,
		}
	}

	return &BackendDescriptor{Routes: routes}
}

// HasBackend reports whether the plugin declares any server-side capability.
// Plugins without a backend skip the approval gate because they expose no
// executable server-side capability.
func HasBackend(m *Manifest) bool {
	return m != nil && m.Backend != nil
}
