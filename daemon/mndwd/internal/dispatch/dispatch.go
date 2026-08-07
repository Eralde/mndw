// Package dispatch serves a plugin's HTTP endpoints (/api/plugins/<name>/<path>) by
// executing its declared sh script under a CGI-ish contract: request metadata in
// the environment, request body on stdin, and a CGI-style Status:/Content-Type:
// header block on stdout. It enforces a per-request timeout, request-body cap, and
// per-plugin concurrent-exec cap, and gates every call on approval + enabled (and
// the session, unless the plugin is public).
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
	"mndwd/internal/output"
	"mndwd/internal/pluginruntime"
	"mndwd/internal/registry"
)

// Defaults applied when Config leaves a limit unset.
const (
	defaultTimeout           = 30 * time.Second
	defaultMaxRequestBytes   = 1 << 20 // 1 MiB
	defaultMaxConcurrentExec = 8
)

// Config carries the backend script dispatch limits.
type Config struct {
	// Timeout bounds a single script execution.
	Timeout time.Duration
	// MaxRequestBytes caps the request body piped to the script's stdin.
	MaxRequestBytes int64
	// MaxConcurrentExec caps simultaneous executions per plugin.
	MaxConcurrentExec int
	// Dev includes a tail of script stderr in error detail (prod responses stay terse).
	Dev bool
	// PluginRuntimeRoot is the root under which each plugin gets private runtime state.
	PluginRuntimeRoot string
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

	sems *pluginSems
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
		sems:   newPluginSems(cfg.MaxConcurrentExec),
	}
}

// Register wires the dispatch route. A single all-methods pattern; method matching
// is done against the resolved endpoint so a wrong verb reads as ROUTE_NOT_FOUND
// A wrong verb reads as ROUTE_NOT_FOUND after endpoint resolution.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/plugins/{name}/{path...}", h.handle)
}

func (h *Handler) handle(w http.ResponseWriter, r *http.Request) {
	request, apiErr := h.resolveDispatch(w, r)
	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}
	defer request.release()

	h.exec(w, r, request.plugin, request.endpoint, request.scriptPath, request.body, request.runtimeDir)
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
func (h *Handler) exec(w http.ResponseWriter, r *http.Request, plugin *registry.Plugin, endpoint manifest.Endpoint, scriptPath string, body []byte, runtimeDir string) {
	ctx, cancel := context.WithTimeout(r.Context(), h.cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, scriptPath)
	configureScriptCommand(cmd)
	cmd.Dir = plugin.Dir
	cmd.Env = h.cgiEnv(r, plugin.Name, endpoint.ID, len(body), runtimeDir)
	cmd.Stdin = bytes.NewReader(body)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	if stderr.Len() > 0 {
		h.logger.Warn("plugin script stderr",
			"plugin", plugin.Name, "endpoint", endpoint.ID, "stderr", string(output.Tail(stderr.Bytes())))
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
// included in detail only in --dev; production responses stay terse while logs
// retain the complete diagnostic.
func (h *Handler) writeScriptError(w http.ResponseWriter, code, message string, stderr []byte) {
	apiErr := httpx.NewError(http.StatusBadGateway, code, message)
	if h.cfg.Dev && len(stderr) > 0 {
		apiErr = apiErr.WithDetail(map[string]string{"stderr": string(output.Tail(stderr))})
	}
	httpx.WriteError(w, h.logger, apiErr)
}

// cgiEnv builds the CGI-ish environment. It inherits the daemon's env (PATH etc.
// from the init script) and appends the request-scoped variables.
func (h *Handler) cgiEnv(r *http.Request, pluginID, endpointID string, contentLength int, runtimeDir string) []string {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}

	env := pluginruntime.SetPluginEnv(os.Environ(), pluginID, runtimeDir)
	env = append(env,
		"REQUEST_METHOD="+r.Method,
		"QUERY_STRING="+r.URL.RawQuery,
		"CONTENT_TYPE="+contentType,
		"CONTENT_LENGTH="+strconv.Itoa(contentLength),
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
