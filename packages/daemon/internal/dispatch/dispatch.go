// Package dispatch serves a plugin's HTTP endpoints (/api/plugins/<name>/<path>) by
// executing its declared sh script under a CGI-ish contract (design §5.3): request
// metadata in the environment, request body on stdin, and a CGI-style
// Status:/Content-Type: header block on stdout. v1 scripts port with a path rename
// only. Unlike v1's mod-cgi it adds hard limits — per-request timeout, request-body
// cap, and a per-plugin concurrent-exec cap — and gates every call on approval +
// enabled (and the session, unless the plugin is public).
package dispatch

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// Defaults applied when Config leaves a limit unset.
const (
	defaultTimeout           = 30 * time.Second
	defaultMaxRequestBytes   = 1 << 20 // 1 MiB
	defaultMaxConcurrentExec = 8
	// maxStderrTail bounds how much script stderr is logged / echoed in --dev detail.
	maxStderrTail = 4 << 10 // 4 KiB
)

// Config carries the dispatch limits (design §5.3).
type Config struct {
	// Timeout bounds a single script execution.
	Timeout time.Duration
	// MaxRequestBytes caps the request body piped to the script's stdin.
	MaxRequestBytes int64
	// MaxConcurrentExec caps simultaneous executions per plugin.
	MaxConcurrentExec int
	// Dev includes a tail of script stderr in error detail (prod responses stay terse).
	Dev bool
}

// Authenticator is the session gate dispatch calls for non-public routes.
type Authenticator interface {
	Authenticate(*http.Request) *httpx.APIError
}

// Handler dispatches /api/plugins/* to plugin scripts.
type Handler struct {
	cfg    Config
	reg    *registry.Registry
	auth   Authenticator
	logger *slog.Logger

	sems *plugerSems
}

// New constructs a dispatch Handler, filling unset limits with defaults.
func New(cfg Config, reg *registry.Registry, auth Authenticator, logger *slog.Logger) *Handler {
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = defaultMaxRequestBytes
	}
	if cfg.MaxConcurrentExec <= 0 {
		cfg.MaxConcurrentExec = defaultMaxConcurrentExec
	}

	return &Handler{
		cfg:    cfg,
		reg:    reg,
		auth:   auth,
		logger: logger,
		sems:   newPlugerSems(cfg.MaxConcurrentExec),
	}
}

// Register wires the dispatch route. A single all-methods pattern; method matching
// is done against the resolved endpoint so a wrong verb reads as ROUTE_NOT_FOUND
// (v1 keyed routes by "METHOD path").
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/plugins/{name}/{path...}", h.handle)
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
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such plugin route"))

		return
	}

	endpoint, script, matched := resolveEndpoint(plugin.Manifest, r.Method, routePath)
	if !matched {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no endpoint matches "+r.Method+" "+routePath))

		return
	}

	if apiErr := approvalGate(plugin); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	// Per-plugin concurrency cap: reject rather than queue so a slow plugin cannot
	// pin the daemon's goroutines.
	release, admitted := h.sems.acquire(name)
	if !admitted {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusTooManyRequests, httpx.CodeTooManyRequests, "too many concurrent requests for this plugin"))

		return
	}
	defer release()

	body, apiErr := h.readBody(w, r)
	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	scriptPath, apiErr := safeScriptPath(plugin.Dir, script.Source)
	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.exec(w, r, plugin, endpoint, scriptPath, body)
}

// approvalGate enforces that a matched route's plugin is approved and enabled. The
// session check is done earlier (it must precede route resolution to avoid leaking
// existence); this is the second half of the gate.
func approvalGate(plugin *registry.Plugin) *httpx.APIError {
	if plugin.Approval != state.ApprovalApproved {
		return httpx.NewError(http.StatusForbidden, httpx.CodeNotApproved, "plugin backend is not approved")
	}
	if !plugin.Enabled {
		return httpx.NewError(http.StatusForbidden, httpx.CodeDisabled, "plugin backend is disabled")
	}

	return nil
}

// readBody reads the request body under the configured cap.
func (h *Handler) readBody(w http.ResponseWriter, r *http.Request) ([]byte, *httpx.APIError) {
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.MaxRequestBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, httpx.NewError(http.StatusRequestEntityTooLarge, httpx.CodeBodyTooLarge, "request body exceeds size limit")
		}

		return nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "failed to read request body")
	}

	return body, nil
}

// exec runs the script and translates its outcome into an HTTP response.
func (h *Handler) exec(w http.ResponseWriter, r *http.Request, plugin *registry.Plugin, endpoint manifest.Endpoint, scriptPath string, body []byte) {
	ctx, cancel := context.WithTimeout(r.Context(), h.cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, scriptPath)
	configureScriptCommand(cmd)
	cmd.Dir = plugin.Dir
	cmd.Env = h.cgiEnv(r, plugin.Name, endpoint.ID, len(body))
	cmd.Stdin = bytes.NewReader(body)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	if stderr.Len() > 0 {
		h.logger.Warn("plugin script stderr",
			"plugin", plugin.Name, "endpoint", endpoint.ID, "stderr", string(tail(stderr.Bytes())))
	}

	if ctx.Err() == context.DeadlineExceeded {
		h.writeScriptError(w, httpx.CodeScriptTimeout, "backend script timed out", stderr.Bytes())

		return
	}
	if runErr != nil {
		h.writeScriptError(w, httpx.CodeScriptFailed, "backend script failed", stderr.Bytes())

		return
	}

	status, header, respBody := parseCGIResponse(stdout.Bytes())
	for key, values := range header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_, _ = w.Write(respBody)
}

// writeScriptError emits a 502 for a failed/timed-out script. The stderr tail is
// included in detail only in --dev (design §5.6: prod responses stay terse, prod
// logs stay complete).
func (h *Handler) writeScriptError(w http.ResponseWriter, code, message string, stderr []byte) {
	apiErr := httpx.NewError(http.StatusBadGateway, code, message)
	if h.cfg.Dev && len(stderr) > 0 {
		apiErr = apiErr.WithDetail(map[string]string{"stderr": string(tail(stderr))})
	}
	httpx.WriteError(w, h.logger, apiErr)
}

// cgiEnv builds the CGI-ish environment (design §5.3). It inherits the daemon's env
// (PATH etc. from the init script) and appends the request-scoped variables.
func (h *Handler) cgiEnv(r *http.Request, pluginID, endpointID string, contentLength int) []string {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}

	env := os.Environ()
	env = append(env,
		"REQUEST_METHOD="+r.Method,
		"QUERY_STRING="+r.URL.RawQuery,
		"CONTENT_TYPE="+contentType,
		"CONTENT_LENGTH="+strconv.Itoa(contentLength),
		"MNDW_PLUGIN_ID="+pluginID,
		"MNDW_ENDPOINT_ID="+endpointID,
	)

	if h.cfg.Dev {
		env = append(env, "MNDW_DEV=1")
	}

	return env
}

// resolveEndpoint finds the endpoint whose method and path match the request, plus
// its referenced script. Match is case-insensitive on method; validation guarantees
// scriptId references a declared script, so a miss here means "no route".
func resolveEndpoint(m *manifest.Manifest, method, path string) (manifest.Endpoint, manifest.Script, bool) {
	if m.Backend == nil {
		return manifest.Endpoint{}, manifest.Script{}, false
	}

	for _, e := range m.Backend.Endpoints {
		if e.Path != path || !strings.EqualFold(e.Method, method) {
			continue
		}
		for _, s := range m.Backend.Scripts {
			if s.ID == e.ScriptID {
				return e, s, true
			}
		}
	}

	return manifest.Endpoint{}, manifest.Script{}, false
}

// safeScriptPath joins the (already schema-validated) relative source onto the
// plugin dir and re-checks it does not escape — defense in depth before exec.
func safeScriptPath(dir, source string) (string, *httpx.APIError) {
	joined := filepath.Join(dir, source)
	if joined != dir && !strings.HasPrefix(joined, dir+string(os.PathSeparator)) {
		return "", httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "script path escapes plugin dir")
	}

	return joined, nil
}

// tail returns the last maxStderrTail bytes of b.
func tail(b []byte) []byte {
	if len(b) <= maxStderrTail {
		return b
	}

	return b[len(b)-maxStderrTail:]
}
