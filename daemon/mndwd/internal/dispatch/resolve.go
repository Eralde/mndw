package dispatch

import (
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/pluginruntime"
	"mndwd/internal/registry"
)

// dispatchRequest contains everything handle needs after request gates and
// filesystem preparation have succeeded.
type dispatchRequest struct {
	plugin     *registry.Plugin
	endpoint   manifest.Endpoint
	script     manifest.Script
	scriptPath string
	runtimeDir string
	body       []byte
	release    func()
}

// resolveDispatch runs request authentication, route resolution, capability
// gates, concurrency admission, body reading, and runtime preparation. It keeps
// those sequential gates independent from HTTP response writing and execution.
func (h *Handler) resolveDispatch(w http.ResponseWriter, r *http.Request) (dispatchRequest, *httpx.APIError) {
	name := r.PathValue("name")
	routePath := r.PathValue("path")

	plugin, found := h.reg.Resolve(name)

	// Session gate first for anything not explicitly public, so an unauthenticated
	// client cannot enumerate installed routes (a 404 vs 403 would leak existence).
	if !(found && plugin.Public()) {
		if apiErr := h.auth.Authenticate(r); apiErr != nil {
			return dispatchRequest{}, apiErr
		}
	}

	if !found || !manifest.HasBackend(plugin.Manifest) {
		return dispatchRequest{}, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such plugin route")
	}

	endpoint, script, matched := resolveEndpoint(plugin.Manifest, r.Method, routePath)
	if !matched {
		return dispatchRequest{}, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no endpoint matches "+r.Method+" "+routePath)
	}

	if endpoint.Sensitive {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
	}

	if endpoint.Csrf && !httpx.CSRFPresent(r) {
		return dispatchRequest{}, httpx.NewError(http.StatusForbidden, httpx.CodeCsrfRequired, "CSRF header required")
	}

	if apiErr := plugin.BackendServable(); apiErr != nil {
		return dispatchRequest{}, apiErr
	}

	release, admitted := h.sems.acquire(name)
	if !admitted {
		return dispatchRequest{}, httpx.NewError(http.StatusTooManyRequests, httpx.CodeTooManyRequests, "too many concurrent requests for this plugin")
	}
	resolved := false
	defer func() {
		if !resolved {
			release()
		}
	}()

	body, apiErr := h.readBody(w, r)
	if apiErr != nil {
		return dispatchRequest{}, apiErr
	}

	scriptPath, apiErr := safeScriptPath(plugin.Dir, script.Source)
	if apiErr != nil {
		return dispatchRequest{}, apiErr
	}

	runtimeDir, err := pluginruntime.Ensure(h.cfg.PluginRuntimeRoot, plugin.Name)
	if err != nil {
		return dispatchRequest{}, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to prepare plugin runtime directory")
	}

	resolved = true
	return dispatchRequest{
		plugin:     plugin,
		endpoint:   endpoint,
		script:     script,
		scriptPath: scriptPath,
		runtimeDir: runtimeDir,
		body:       body,
		release:    release,
	}, nil
}
