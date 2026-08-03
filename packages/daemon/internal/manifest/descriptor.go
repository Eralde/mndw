package manifest

// EndpointDescriptor is the resolved shape the host's backend client needs to
// build a request URL: method + relative path, keyed by endpoint id.
type EndpointDescriptor struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	Csrf      bool   `json:"csrf,omitempty"`
	Sensitive bool   `json:"sensitive,omitempty"`
}

// WebSocketDescriptor is the resolved shape for a websocket binding, keyed by id.
// Target is intentionally omitted — it is a host-internal dial address the client
// never sees.
type WebSocketDescriptor struct {
	Path      string   `json:"path"`
	Protocols []string `json:"protocols,omitempty"`
}

// BackendDescriptor is the client-facing capability snapshot surfaced in
// GET /api/mgmt/list, minus the approval/enabled/public state which the mgmt layer
// overlays from state.json. It also drives the approval UI's capability display
// (opkg deps, daemon hooks).
type BackendDescriptor struct {
	Endpoints  map[string]EndpointDescriptor  `json:"endpoints"`
	WebSockets map[string]WebSocketDescriptor `json:"websockets"`
	Opkg       []string                       `json:"opkg"`
	Daemon     bool                           `json:"daemon"`
	Public     bool                           `json:"public"`
}

// Descriptor derives the client-facing backend capability snapshot from the
// manifest. Returns nil when the plugin declares no backend.
func (m *Manifest) Descriptor() *BackendDescriptor {
	if m.Backend == nil {
		return &BackendDescriptor{
			Endpoints:  map[string]EndpointDescriptor{},
			WebSockets: map[string]WebSocketDescriptor{},
			Opkg:       []string{},
		}
	}

	b := m.Backend
	endpoints := make(map[string]EndpointDescriptor, len(b.Endpoints))
	for _, e := range b.Endpoints {
		endpoints[e.ID] = EndpointDescriptor{
			Method:    e.Method,
			Path:      e.Path,
			Csrf:      e.Csrf,
			Sensitive: e.Sensitive,
		}
	}

	websockets := make(map[string]WebSocketDescriptor, len(b.WebSockets))
	for _, ws := range b.WebSockets {
		websockets[ws.ID] = WebSocketDescriptor{Path: ws.Path, Protocols: ws.Protocols}
	}

	opkg := b.Opkg
	if opkg == nil {
		opkg = []string{}
	}

	public := b.Public != nil && *b.Public

	return &BackendDescriptor{
		Endpoints:  endpoints,
		WebSockets: websockets,
		Opkg:       opkg,
		Daemon:     b.Daemon != nil,
		Public:     public,
	}
}

// HasBackend reports whether the plugin declares any server-side capability.
// Plugins without a backend skip the approval gate because they expose no
// executable server-side capability.
func (m *Manifest) HasBackend() bool {
	return m.Backend != nil
}
