package backend

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type GatewayConfig struct {
	MaxRequestBytes           int64
	ServiceHTTPTimeout        time.Duration
	AllowSymlinkedBuiltinRoot bool
	ActivationGates           *ActivationGateRegistry
}

type Authenticator interface {
	Authenticate(*http.Request) *httpx.APIError
}

type transportKind int

const (
	transportHTTP transportKind = iota
	transportWebSocket
)

type routeDecision struct {
	plugin *registry.Plugin
	route  manifest.BackendRoute
}

type Gateway struct {
	cfg             GatewayConfig
	registry        *registry.Registry
	auth            Authenticator
	runtime         *RuntimeImpl
	traffic         *TrafficGate
	activationGates *ActivationGateRegistry
	logger          *slog.Logger
}

func NewGateway(cfg GatewayConfig, registry *registry.Registry, auth Authenticator, runtime *RuntimeImpl, logger *slog.Logger) *Gateway {
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = 1 << 20
	}

	if cfg.ServiceHTTPTimeout <= 0 {
		cfg.ServiceHTTPTimeout = 30 * time.Second
	}

	traffic := NewTrafficGate()

	if runtime != nil {
		traffic = runtime.Traffic()
	}

	return &Gateway{
		cfg:             cfg,
		registry:        registry,
		auth:            auth,
		runtime:         runtime,
		traffic:         traffic,
		activationGates: cfg.ActivationGates,
		logger:          logger,
	}
}

func (g *Gateway) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/plugins/{name}/_mndw/status", g.handleStatus)
	mux.HandleFunc("/api/plugins/{name}/{path...}", g.handle)
	mux.HandleFunc("/ws/plugins/{name}/{path...}", g.handleWebSocket)
}

// resolveAuthorizedRoute runs the prelude shared by the HTTP and WebSocket
// backend handlers: path canonicalization, WebSocket origin validation,
// maintenance gating, registry resolution, route matching, authentication, and
// the backend-servable check. It writes any error response itself and returns
// ok=false when the caller must stop.
//
// Non-disclosure invariant: an unauthenticated caller must receive the same
// response whether or not a route exists. Every not-found branch therefore
// authenticates FIRST and returns the authentication error on failure; only an
// authenticated caller is ever told a route is missing (404). Per-plugin gates
// also run after authentication, so an unauthenticated caller cannot learn a
// plugin's lifecycle or activation state; public routes are the deliberate
// exception. Do not reorder these checks or discard the authenticate() result.
func (g *Gateway) resolveAuthorizedRoute(writer http.ResponseWriter, request *http.Request, kind transportKind) (routeDecision, bool) {
	path, canonical := CanonicalRoutePath(request.PathValue("path"))

	if !canonical {
		if kind == transportWebSocket {
			g.writeError(writer, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "invalid websocket path"))
		} else {
			g.writeError(writer, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "non-canonical backend path"))
		}

		return routeDecision{}, false
	}

	if kind == transportWebSocket && !ValidWebSocketOrigin(request) {
		g.writeError(writer, httpx.NewError(http.StatusForbidden, httpx.CodeUnauthorized, "invalid websocket origin"))

		return routeDecision{}, false
	}

	// Platform maintenance (daemon shutdown / package replacement) gates every
	// backend, including plugins that never resolve, so it is checked first.
	if g.isPlatformMaintenance() {
		g.writeMaintenance(writer)

		return routeDecision{}, false
	}

	plugin, found := g.registry.Resolve(request.PathValue("name"))

	if !found || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil {
		if !g.authenticate(writer, request) {
			return routeDecision{}, false
		}

		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such backend route"))

		return routeDecision{}, false
	}

	route, matched := g.matchRoute(plugin.Manifest, request, kind, path)

	if !matched {
		if !g.authenticate(writer, request) {
			return routeDecision{}, false
		}

		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, noRouteMessage(kind)))

		return routeDecision{}, false
	}

	if route.Access != "public" && !g.authenticate(writer, request) {
		return routeDecision{}, false
	}

	// An unmet activation prerequisite (e.g. an unconfigured persistent-RCI
	// controller token or an ungranted permission) is a steady state, not the
	// transient stop the traffic gate represents. Surfacing it before the
	// per-plugin traffic gate lets callers tell "won't start until a prerequisite
	// is met" apart from "briefly under maintenance while restarting".
	if blockers := g.activationBlockers(plugin); len(blockers) > 0 {
		g.writeBlocked(writer, blockers)

		return routeDecision{}, false
	}

	if g.pluginTrafficBlocked(request.PathValue("name")) {
		g.writeMaintenance(writer)

		return routeDecision{}, false
	}

	if apiErr := plugin.BackendServable(); apiErr != nil {
		g.writeError(writer, apiErr)

		return routeDecision{}, false
	}

	return routeDecision{plugin: plugin, route: route}, true
}

func (g *Gateway) matchRoute(m *manifest.Manifest, request *http.Request, kind transportKind, path string) (manifest.BackendRoute, bool) {
	if kind == transportWebSocket {
		return resolveWebSocketRoute(m, path)
	}

	return resolveRoute(m, request.Method, path)
}

func noRouteMessage(kind transportKind) string {
	if kind == transportWebSocket {
		return "no websocket route matches request"
	}

	return "no backend route matches request"
}

func (g *Gateway) handle(writer http.ResponseWriter, request *http.Request) {
	writer = httpx.NewNoCORSResponseWriter(writer)

	writer.Header().Set("Cache-Control", "no-store")

	decision, ok := g.resolveAuthorizedRoute(writer, request, transportHTTP)

	if !ok {
		return
	}

	plugin, route := decision.plugin, decision.route

	if route.Transport == "http" && route.Access != "public" && request.Method != http.MethodGet && request.Method != http.MethodHead {
		if !httpx.RequireCSRF(writer, g.logger, request) {
			return
		}
	}

	switch *plugin.Manifest.Backend.Kind {
	case manifest.BackendKindExec:
		g.serveExec(writer, request, plugin, route)
	case manifest.BackendKindService:
		g.serveService(writer, request, plugin, route)
	default:
		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "unsupported backend kind"))
	}
}

func (g *Gateway) authenticate(writer http.ResponseWriter, request *http.Request) bool {
	if g.auth == nil {
		return true
	}

	if apiErr := g.auth.Authenticate(request); apiErr != nil {
		g.writeError(writer, apiErr)

		return false
	}

	return true
}

func (g *Gateway) serveExec(writer http.ResponseWriter, request *http.Request, plugin *registry.Plugin, route manifest.BackendRoute) {
	if g.runtime == nil {
		g.writeError(writer, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "exec backend is not configured"))

		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, g.cfg.MaxRequestBytes)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		if errors.Is(err, http.ErrBodyReadAfterClose) {
			g.writeError(writer, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body is unreadable"))

			return
		}

		g.writeError(writer, httpx.NewError(http.StatusRequestEntityTooLarge, httpx.CodeBackendBodyTooLarge, "request body exceeds backend limit"))

		return
	}

	validated, err := g.validateCommand(plugin, route.Command)
	if err != nil {
		g.writeError(writer, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "backend command is invalid"))

		return
	}

	apiErr := g.runtime.ServeExec(request.Context(), ExecRequest{
		PluginID: plugin.Name,
		RouteID:  route.ID,
		Dir:      plugin.Dir,
		Command:  validated.Path,
		Method:   request.Method,
		Query:    request.URL.RawQuery,
		Body:     body,
		Type:     request.Header.Get("Content-Type"),
	}, writer)

	if apiErr != nil {
		g.writeError(writer, apiErr)
	}
}

func (g *Gateway) validateCommand(plugin *registry.Plugin, relative string) (ValidatedCommand, error) {
	if plugin.Source == state.SourceBuiltin && g.cfg.AllowSymlinkedBuiltinRoot {
		return validateBuiltinCommand(plugin.Dir, relative)
	}

	return ValidateCommand(plugin.Dir, relative)
}

func (g *Gateway) serveService(writer http.ResponseWriter, request *http.Request, plugin *registry.Plugin, route manifest.BackendRoute) {
	if g.runtime == nil {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	if plugin.Manifest.Backend.ProtocolVersion == nil || !g.runtime.SupportsProtocol(*plugin.Manifest.Backend.ProtocolVersion) {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendIncompatible, "service backend protocol is unsupported"))

		return
	}

	status := g.runtime.Status(plugin.Name)

	if status.State != StateReady {
		if status.State == StateStarting || status.State == StateBackoff {
			if status.NextAttemptAt != nil {
				seconds := int(status.NextAttemptAt.Sub(g.runtime.Now()).Seconds())

				if seconds < 1 {
					seconds = 1
				}

				writer.Header().Set("Retry-After", strconv.Itoa(seconds))
			}

			g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendStarting, "service backend is starting"))

			return
		}

		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	socketPath, ok := g.runtime.SocketPath(plugin.Name)

	if !ok {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, g.cfg.MaxRequestBytes)

	if err := proxyServiceHTTP(request.Context(), writer, request, socketPath, plugin.Name, route.ID, route.Path, g.cfg.ServiceHTTPTimeout); err != nil {
		g.writeError(writer, httpx.NewError(http.StatusBadGateway, httpx.CodeBadGateway, "service backend is unavailable"))
	}
}

func (g *Gateway) handleWebSocket(writer http.ResponseWriter, request *http.Request) {
	writer = httpx.NewNoCORSResponseWriter(writer)

	writer.Header().Set("Cache-Control", "no-store")

	decision, ok := g.resolveAuthorizedRoute(writer, request, transportWebSocket)

	if !ok {
		return
	}

	plugin, route := decision.plugin, decision.route

	if g.runtime == nil || g.runtime.Status(plugin.Name).State != StateReady {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	socketPath, ok := g.runtime.SocketPath(plugin.Name)

	if !ok {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	protocol, acceptable := negotiateWebSocketProtocol(route.Protocols, request.Header.Values("Sec-WebSocket-Protocol"))

	if !acceptable {
		g.writeError(writer, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "no acceptable websocket subprotocol"))

		return
	}

	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: g.cfg.ServiceHTTPTimeout}

	defer transport.CloseIdleConnections()

	upstreamURL := &url.URL{Scheme: "ws", Host: "mndw", Path: "/" + strings.TrimPrefix(route.Path, "/"), RawQuery: request.URL.RawQuery}
	dialOptions := &websocket.DialOptions{HTTPClient: client, Host: "mndw", HTTPHeader: http.Header{
		"X-Mndw-Plugin-Id": []string{plugin.Name},
		"X-Mndw-Route-Id":  []string{route.ID},
	}}

	if protocol != "" {
		dialOptions.Subprotocols = []string{protocol}
	}

	upstream, _, err := websocket.Dial(request.Context(), upstreamURL.String(), dialOptions)
	if err != nil {
		g.writeError(writer, httpx.NewError(http.StatusBadGateway, httpx.CodeBadGateway, "service websocket is unavailable"))

		return
	}

	defer upstream.CloseNow()

	acceptOptions := &websocket.AcceptOptions{}

	if protocol != "" {
		acceptOptions.Subprotocols = []string{protocol}
	}

	clientConn, err := websocket.Accept(writer, request, acceptOptions)
	if err != nil {
		return
	}

	defer clientConn.CloseNow()

	untrack, admitted := g.admitWebSocket(clientConn, plugin.Name)

	if !admitted {
		return
	}

	defer untrack()

	clientConn.SetReadLimit(32 << 20)
	upstream.SetReadLimit(32 << 20)
	proxyWebSocket(request.Context(), clientConn, upstream)
}

func (g *Gateway) isMaintenance(pluginID string) bool {
	return g.isPlatformMaintenance() || g.pluginTrafficBlocked(pluginID)
}

// isPlatformMaintenance reports the coarse gate applied to every backend during
// daemon shutdown or package replacement.
func (g *Gateway) isPlatformMaintenance() bool {
	return g.traffic != nil && g.traffic.PlatformMaintenance()
}

// pluginTrafficBlocked reports the per-plugin lifecycle traffic gate, which is
// held only while a plugin is stopping, restarting, or otherwise mid-operation.
func (g *Gateway) pluginTrafficBlocked(pluginID string) bool {
	return g.runtime != nil && g.runtime.BlocksTraffic(pluginID)
}

// activationBlockers returns the unmet activation prerequisites for a plugin's
// declared permissions, in manifest order, or nil when all are satisfied.
func (g *Gateway) activationBlockers(plugin *registry.Plugin) []ActivationBlocker {
	if g.activationGates == nil || plugin == nil || plugin.Manifest == nil || plugin.Manifest.Backend == nil {
		return nil
	}

	// Activation gates are enforced only for service backends (see serviceSpec);
	// exec backends are never gated, so never report them as blocked.
	if plugin.Manifest.Backend.Kind == nil || *plugin.Manifest.Backend.Kind != manifest.BackendKindService {
		return nil
	}

	return g.activationGates.Evaluate(plugin.Name, plugin.Manifest.Permissions)
}

func (g *Gateway) admitWebSocket(connection socketCloser, pluginID string) (func(), bool) {
	untrack, ok := g.traffic.Track(connection, pluginID)

	if !ok || g.pluginTrafficBlocked(pluginID) {
		untrack()

		_ = connection.Close(websocket.StatusServiceRestart, "mndw updating")

		return func() {}, false
	}

	return untrack, true
}

func proxyWebSocket(ctx context.Context, client, upstream *websocket.Conn) {
	proxyContext, cancel := context.WithCancel(ctx)

	defer cancel()

	done := make(chan struct{}, 2)
	copyWebSocket := func(source, destination *websocket.Conn) {
		defer func() { done <- struct{}{} }()

		for {
			typ, payload, err := source.Read(proxyContext)
			if err != nil {
				return
			}

			if err := destination.Write(proxyContext, typ, payload); err != nil {
				return
			}
		}
	}

	go copyWebSocket(client, upstream)

	go copyWebSocket(upstream, client)

	<-done
	cancel()

	_ = client.Close(websocket.StatusNormalClosure, "proxy closed")
	_ = upstream.Close(websocket.StatusNormalClosure, "proxy closed")
}

func (g *Gateway) writeError(writer http.ResponseWriter, apiErr *httpx.APIError) {
	if writer == nil {
		return
	}

	httpx.WriteError(writer, g.logger, apiErr)
}

func (g *Gateway) writeMaintenance(writer http.ResponseWriter) {
	writer.Header().Set("Retry-After", "2")
	g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendMaintenance, "backend is under maintenance"))
}

func (g *Gateway) writeBlocked(writer http.ResponseWriter, blockers []ActivationBlocker) {
	detail := make([]backendStatusBlocker, 0, len(blockers))

	for _, blocker := range blockers {
		detail = append(detail, backendStatusBlocker{
			Permission:   blocker.Permission,
			Reason:       string(blocker.Reason),
			Prerequisite: blocker.Prerequisite,
		})
	}

	g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendBlocked,
		"backend is blocked on an unmet activation prerequisite").WithDetail(detail))
}

func resolveRoute(m *manifest.Manifest, method, path string) (manifest.BackendRoute, bool) {
	if m == nil || m.Backend == nil {
		return manifest.BackendRoute{}, false
	}

	for _, route := range m.Backend.Routes {
		if route.Path != path || route.Transport != "http" || !strings.EqualFold(route.Method, method) {
			continue
		}

		return route, true
	}

	return manifest.BackendRoute{}, false
}

func resolveWebSocketRoute(m *manifest.Manifest, path string) (manifest.BackendRoute, bool) {
	if m == nil || m.Backend == nil {
		return manifest.BackendRoute{}, false
	}

	for _, route := range m.Backend.Routes {
		if route.Transport == "websocket" && route.Path == path {
			return route, true
		}
	}

	return manifest.BackendRoute{}, false
}

func negotiateWebSocketProtocol(allowed []string, requested []string) (string, bool) {
	if len(allowed) == 0 {
		return "", true
	}

	requestedProtocols := make([]string, 0)

	for _, header := range requested {
		requestedProtocols = append(requestedProtocols, strings.Split(header, ",")...)
	}

	for _, candidate := range requestedProtocols {
		candidate = strings.TrimSpace(candidate)

		for _, permitted := range allowed {
			if candidate == permitted {
				return candidate, true
			}
		}
	}

	return "", false
}
