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

// ApprovalReview summarizes what an owner approves. This projection exposes
// backend kind, package names, arguments, and public route IDs to every same-origin
// plugin that can read GET /api/mgmt/list. These are metadata, not secrets.
type ApprovalReview struct {
	Kind         string   `json:"kind"`
	Packages     []string `json:"packages,omitempty"`
	Args         []string `json:"args,omitempty"`
	PublicRoutes []string `json:"publicRoutes,omitempty"`
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

// Review derives the capability summary shown at backend approval. The same-origin
// management list exposes these fields to plugins, so manifests must not put
// secrets in arguments or package metadata.
func Review(m *Manifest) *ApprovalReview {
	if m == nil || m.Backend == nil {
		return nil
	}

	b := m.Backend
	kind := ""
	if b.Kind != nil {
		kind = string(*b.Kind)
	}

	review := &ApprovalReview{
		Kind:     kind,
		Packages: append([]string(nil), b.Packages...),
		Args:     append([]string(nil), b.Args...),
	}

	for _, route := range b.Routes {
		if route.Access == "public" {
			review.PublicRoutes = append(review.PublicRoutes, route.ID)
		}
	}

	return review
}

// HasBackend reports whether the plugin declares any server-side capability.
// Plugins without a backend skip the approval gate because they expose no
// executable server-side capability.
func HasBackend(m *Manifest) bool {
	return m != nil && m.Backend != nil
}
