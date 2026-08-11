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
	"sync"
	"time"

	"github.com/coder/websocket"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
)

type GatewayConfig struct {
	MaxRequestBytes    int64
	ServiceHTTPTimeout time.Duration
}

type Authenticator interface {
	Authenticate(*http.Request) *httpx.APIError
}

type Gateway struct {
	cfg                 GatewayConfig
	registry            *registry.Registry
	auth                Authenticator
	exec                *ExecRunner
	supervisor          *Supervisor
	logger              *slog.Logger
	activeMu            sync.Mutex
	activeWS            map[*websocket.Conn]string
	maintenanceMu       sync.RWMutex
	maintenance         map[string]struct{}
	platformMaintenance bool
}

func NewGateway(cfg GatewayConfig, registry *registry.Registry, auth Authenticator, execRunner *ExecRunner, supervisor *Supervisor, logger *slog.Logger) *Gateway {
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = 1 << 20
	}

	if cfg.ServiceHTTPTimeout <= 0 {
		cfg.ServiceHTTPTimeout = 30 * time.Second
	}

	return &Gateway{
		cfg:         cfg,
		registry:    registry,
		auth:        auth,
		exec:        execRunner,
		supervisor:  supervisor,
		logger:      logger,
		activeWS:    make(map[*websocket.Conn]string),
		maintenance: make(map[string]struct{}),
	}
}

func (g *Gateway) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/plugins/{name}/{path...}", g.handle)
	mux.HandleFunc("/ws/plugins/{name}/{path...}", g.handleWebSocket)
}

func (g *Gateway) handle(writer http.ResponseWriter, request *http.Request) {
	writer = httpx.NewNoCORSResponseWriter(writer)

	writer.Header().Set("Cache-Control", "no-store")

	path, canonical := CanonicalRoutePath(request.PathValue("path"))

	if !canonical {
		g.writeError(writer, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "non-canonical backend path"))

		return
	}

	if g.isMaintenance(request.PathValue("name")) {
		g.writeMaintenance(writer)

		return
	}

	plugin, found := g.registry.Resolve(request.PathValue("name"))

	if !found || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil {
		g.authenticate(writer, request)
		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such backend route"))

		return
	}

	route, matched := resolveV3Route(plugin.Manifest, request.Method, path)

	if !matched {
		g.authenticate(writer, request)
		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no backend route matches request"))

		return
	}

	if route.Access != "public" {
		if !g.authenticate(writer, request) {
			return
		}
	}

	if apiErr := plugin.BackendServable(); apiErr != nil {
		g.writeError(writer, apiErr)

		return
	}

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
	if g.exec == nil {
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

	validated, err := ValidateCommand(plugin.Dir, route.Command)
	if err != nil {
		g.writeError(writer, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "backend command is invalid"))

		return
	}

	apiErr := g.exec.Serve(request.Context(), ExecRequest{
		PluginID:   plugin.Name,
		RouteID:    route.ID,
		Dir:        plugin.Dir,
		Command:    validated.Path,
		RuntimeDir: runtimeDir(g.exec, plugin.Name),
		Method:     request.Method,
		Query:      request.URL.RawQuery,
		Body:       body,
		Type:       request.Header.Get("Content-Type"),
	}, writer)

	if apiErr != nil {
		g.writeError(writer, apiErr)
	}
}

func runtimeDir(runner *ExecRunner, pluginID string) string {
	if runner == nil || runner.cfg.RuntimeRoot == "" {
		return ""
	}

	paths, err := NewRuntimePaths(runner.cfg.RuntimeRoot, pluginID)
	if err != nil {
		return ""
	}

	if err := paths.Ensure(); err != nil {
		return ""
	}

	return paths.PluginDir
}

func (g *Gateway) serveService(writer http.ResponseWriter, request *http.Request, plugin *registry.Plugin, route manifest.BackendRoute) {
	if g.supervisor == nil {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	if plugin.Manifest.Backend.ProtocolVersion == nil || !g.supervisor.SupportsProtocol(*plugin.Manifest.Backend.ProtocolVersion) {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendIncompatible, "service backend protocol is unsupported"))

		return
	}

	status := g.supervisor.Status(plugin.Name)

	if status.State != StateReady {
		if status.State == StateStarting || status.State == StateBackoff {
			if status.NextAttemptAt != nil {
				seconds := int(time.Until(*status.NextAttemptAt).Seconds())

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

	socketPath, ok := g.supervisor.SocketPath(plugin.Name)

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

	path, canonical := CanonicalRoutePath(request.PathValue("path"))

	if !canonical {
		g.writeError(writer, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "invalid websocket path"))

		return
	}

	if !ValidWebSocketOrigin(request) {
		g.writeError(writer, httpx.NewError(http.StatusForbidden, httpx.CodeUnauthorized, "invalid websocket origin"))

		return
	}

	if g.isMaintenance(request.PathValue("name")) {
		g.writeMaintenance(writer)

		return
	}

	plugin, found := g.registry.Resolve(request.PathValue("name"))

	if !found || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil {
		g.authenticate(writer, request)
		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such backend route"))

		return
	}

	route, matched := resolveV3WebSocketRoute(plugin.Manifest, path)

	if !matched {
		if !g.authenticate(writer, request) {
			return
		}

		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no websocket route matches request"))

		return
	}

	if route.Access != "public" && !g.authenticate(writer, request) {
		return
	}

	if apiErr := plugin.BackendServable(); apiErr != nil {
		g.writeError(writer, apiErr)

		return
	}

	if g.supervisor == nil || g.supervisor.Status(plugin.Name).State != StateReady {
		g.writeError(writer, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "service backend is unavailable"))

		return
	}

	socketPath, ok := g.supervisor.SocketPath(plugin.Name)

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

	g.trackWebSocket(clientConn, plugin.Name)

	defer g.untrackWebSocket(clientConn)

	clientConn.SetReadLimit(32 << 20)
	upstream.SetReadLimit(32 << 20)
	proxyWebSocket(request.Context(), clientConn, upstream)
}

// ClosePluginSockets ends browser streams before a plugin update/disable stops
// its service. The close code/reason are stable so terminal-like clients can
// render an explicit reconnect action without silently resuming a session.
func (g *Gateway) ClosePluginSockets(pluginID string) {
	g.closeSockets(func(id string) bool { return id == pluginID })
}

func (g *Gateway) CloseAllSockets() {
	g.closeSockets(func(string) bool { return true })
}

// BeginPluginMaintenance rejects new traffic before stopping the service and
// closes existing browser sockets with the maintenance close code.
func (g *Gateway) BeginPluginMaintenance(pluginID string) {
	g.maintenanceMu.Lock()

	g.maintenance[pluginID] = struct{}{}

	g.maintenanceMu.Unlock()
	g.ClosePluginSockets(pluginID)
}

func (g *Gateway) EndPluginMaintenance(pluginID string) {
	g.maintenanceMu.Lock()
	delete(g.maintenance, pluginID)
	g.maintenanceMu.Unlock()
}

// BeginPlatformMaintenance applies the same gate to every backend during
// daemon shutdown or package replacement.
func (g *Gateway) BeginPlatformMaintenance() {
	g.maintenanceMu.Lock()

	g.platformMaintenance = true

	g.maintenanceMu.Unlock()
	g.CloseAllSockets()
}

func (g *Gateway) isMaintenance(pluginID string) bool {
	g.maintenanceMu.RLock()

	defer g.maintenanceMu.RUnlock()

	if g.platformMaintenance {
		return true
	}

	_, active := g.maintenance[pluginID]

	return active
}

func (g *Gateway) trackWebSocket(connection *websocket.Conn, pluginID string) {
	g.activeMu.Lock()

	g.activeWS[connection] = pluginID

	g.activeMu.Unlock()
}

func (g *Gateway) untrackWebSocket(connection *websocket.Conn) {
	g.activeMu.Lock()
	delete(g.activeWS, connection)
	g.activeMu.Unlock()
}

func (g *Gateway) closeSockets(keep func(string) bool) {
	g.activeMu.Lock()

	connections := make([]*websocket.Conn, 0, len(g.activeWS))

	for connection, pluginID := range g.activeWS {
		if keep(pluginID) {
			connections = append(connections, connection)
		}
	}

	g.activeMu.Unlock()

	for _, connection := range connections {
		_ = connection.Close(websocket.StatusServiceRestart, "mndw updating")
	}
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

func resolveV3Route(m *manifest.Manifest, method, path string) (manifest.BackendRoute, bool) {
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

func resolveV3WebSocketRoute(m *manifest.Manifest, path string) (manifest.BackendRoute, bool) {
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
