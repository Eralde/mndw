// Package wsproxy bridges a browser websocket (/ws/plugins/<name>/<path>) to the
// target a plugin's manifest declares (design §5.5). It replaces v1's committed
// prebuilt gateway binary, built from source here. Before upgrading it runs the same
// gate as dispatch — approval + enabled, and the session check unless the plugin is
// public — then negotiates the declared subprotocol intersection and pumps frames
// both ways until either side closes.
package wsproxy

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

const (
	// readLimit lifts coder's 32 KiB default: proxied streams (terminals, log tails)
	// routinely exceed it and a proxy must not truncate them.
	readLimit = 32 << 20 // 32 MiB
	// dialTimeout bounds the upstream handshake to the plugin's backend.
	dialTimeout = 10 * time.Second
)

// Authenticator is the session gate wsproxy calls for non-public routes.
type Authenticator interface {
	Authenticate(*http.Request) *httpx.APIError
}

// Handler proxies /ws/plugins/* to declared targets.
type Handler struct {
	reg    *registry.Registry
	auth   Authenticator
	logger *slog.Logger
}

// New constructs a wsproxy Handler.
func New(reg *registry.Registry, auth Authenticator, logger *slog.Logger) *Handler {
	return &Handler{reg: reg, auth: auth, logger: logger}
}

// Register wires the ws proxy route.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/ws/plugins/{name}/{path...}", h.handle)
}

func (h *Handler) handle(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	routePath := r.PathValue("path")

	plugin, found := h.reg.Resolve(name)

	// Session gate first for anything not explicitly public, so an unauthenticated
	// client cannot enumerate installed routes (a 404 vs 403 would leak existence).
	if !(found && plugin.Public()) {
		if apiErr := h.auth.Authenticate(r); apiErr != nil {
			httpx.WriteError(w, h.logger, apiErr)

			return
		}
	}

	if !found || !plugin.Manifest.HasBackend() {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such plugin websocket"))

		return
	}

	binding, matched := resolveWebSocket(plugin.Manifest, routePath)
	if !matched {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no websocket matches "+routePath))

		return
	}

	if apiErr := approvalGate(plugin); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	negotiated, acceptable := negotiateSubprotocol(binding.Protocols, clientSubprotocols(r))
	if !acceptable {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "no acceptable websocket subprotocol"))

		return
	}

	// Dial the target before upgrading the client, so a dead backend yields a clean
	// HTTP 502 envelope rather than an opened-then-closed socket.
	dialCtx, cancel := context.WithTimeout(r.Context(), dialTimeout)
	defer cancel()

	dialOpts := &websocket.DialOptions{}
	if negotiated != "" {
		dialOpts.Subprotocols = []string{negotiated}
	}
	target, _, err := websocket.Dial(dialCtx, normalizeTarget(binding.Target), dialOpts)
	if err != nil {
		h.logger.Warn("ws dial target failed", "plugin", name, "target", binding.Target, "error", err)
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeBadGateway, "plugin backend is unavailable"))

		return
	}
	defer target.CloseNow()
	target.SetReadLimit(readLimit)

	acceptOpts := &websocket.AcceptOptions{}
	if negotiated != "" {
		acceptOpts.Subprotocols = []string{negotiated}
	}
	client, err := websocket.Accept(w, r, acceptOpts)
	if err != nil {
		// Accept has already written the failure response.
		h.logger.Warn("ws accept failed", "plugin", name, "error", err)

		return
	}
	defer client.CloseNow()
	client.SetReadLimit(readLimit)

	h.pump(client, target)
}

// approvalGate enforces that a matched route's plugin is approved and enabled. The
// session check runs earlier (before route resolution, to avoid leaking existence);
// this is the second half of the gate.
func approvalGate(plugin *registry.Plugin) *httpx.APIError {
	if plugin.Approval != state.ApprovalApproved {
		return httpx.NewError(http.StatusForbidden, httpx.CodeNotApproved, "plugin backend is not approved")
	}
	if !plugin.Enabled {
		return httpx.NewError(http.StatusForbidden, httpx.CodeDisabled, "plugin backend is disabled")
	}

	return nil
}

// pump copies messages in both directions until either side errors (close/EOF),
// then unblocks and tears down the other direction.
func (h *Handler) pump(client, target *websocket.Conn) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{}, 2)
	go func() {
		copyMessages(ctx, target, client) // client → target
		cancel()
		done <- struct{}{}
	}()
	go func() {
		copyMessages(ctx, client, target) // target → client
		cancel()
		done <- struct{}{}
	}()

	// Wait for both directions to unwind so neither goroutine touches a conn after
	// the deferred CloseNow runs.
	<-done
	<-done
}

func copyMessages(ctx context.Context, dst, src *websocket.Conn) {
	for {
		typ, data, err := src.Read(ctx)
		if err != nil {
			return
		}
		if err := dst.Write(ctx, typ, data); err != nil {
			return
		}
	}
}

// resolveWebSocket finds the ws binding whose path matches the request.
func resolveWebSocket(m *manifest.Manifest, path string) (manifest.WebSocket, bool) {
	if m.Backend == nil {
		return manifest.WebSocket{}, false
	}
	for _, ws := range m.Backend.WebSockets {
		if ws.Path == path {
			return ws, true
		}
	}

	return manifest.WebSocket{}, false
}

// negotiateSubprotocol implements the v1 gateway rule: the chosen subprotocol is the
// first client-offered one the manifest also declares. When the manifest declares
// none there is no restriction (no subprotocol is selected). A rejection (false)
// happens only when the manifest declares a set and the client offered subprotocols
// that are all outside it.
func negotiateSubprotocol(declared, offered []string) (chosen string, acceptable bool) {
	if len(declared) == 0 {
		return "", true
	}
	for _, c := range offered {
		if slices.Contains(declared, c) {
			return c, true
		}
	}
	if len(offered) == 0 {
		return "", true
	}

	return "", false
}

// clientSubprotocols parses the Sec-WebSocket-Protocol request header(s).
func clientSubprotocols(r *http.Request) []string {
	var out []string
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, p := range strings.Split(header, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
	}

	return out
}

// normalizeTarget coerces a declared dial target to a ws:// or wss:// URL. A bare
// host:port defaults to ws://.
func normalizeTarget(target string) string {
	switch {
	case strings.HasPrefix(target, "ws://"), strings.HasPrefix(target, "wss://"):
		return target
	case strings.HasPrefix(target, "http://"):
		return "ws://" + strings.TrimPrefix(target, "http://")
	case strings.HasPrefix(target, "https://"):
		return "wss://" + strings.TrimPrefix(target, "https://")
	default:
		return "ws://" + target
	}
}
