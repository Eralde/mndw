package backend

import (
	"math"
	"net/http"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type backendStatusBlocker struct {
	Permission   string `json:"permission"`
	Reason       string `json:"reason"`
	Prerequisite string `json:"prerequisite,omitempty"`
}

type backendStatusResponse struct {
	Kind               string                 `json:"kind"`
	State              string                 `json:"state"`
	RetryAfterSeconds  *int                   `json:"retryAfterSeconds"`
	Blockers           []backendStatusBlocker `json:"blockers,omitempty"`
	RequiredProtocol   *int                   `json:"requiredProtocol,omitempty"`
	SupportedProtocols *[]int                 `json:"supportedProtocols,omitempty"`
}

func retryAfterSeconds(now time.Time, next *time.Time) *int {
	if next == nil || !next.After(now) {
		return nil
	}

	seconds := int(math.Ceil(next.Sub(now).Seconds()))

	return &seconds
}

func (g *Gateway) projectBackendStatus(plugin *registry.Plugin, now time.Time) backendStatusResponse {
	response := backendStatusResponse{RetryAfterSeconds: nil}

	if plugin == nil || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil {
		response.State = "unavailable"

		return response
	}

	response.Kind = string(*plugin.Manifest.Backend.Kind)

	if !plugin.Enabled {
		response.State = "disabled"

		return response
	}

	if plugin.Approval != state.ApprovalApproved {
		response.State = "not-approved"

		return response
	}

	// An unmet activation prerequisite is a steady state, distinct from the
	// transient traffic gate. Report it ahead of maintenance so the frontend can
	// render the missing prerequisite rather than a generic "under maintenance".
	if g.activationGates != nil && *plugin.Manifest.Backend.Kind == manifest.BackendKindService {
		if blockers := g.activationGates.Evaluate(plugin.Name, plugin.Manifest.Permissions); len(blockers) > 0 {
			response.State = "blocked"
			response.Blockers = make([]backendStatusBlocker, 0, len(blockers))

			for _, blocker := range blockers {
				response.Blockers = append(response.Blockers, backendStatusBlocker{
					Permission:   blocker.Permission,
					Reason:       string(blocker.Reason),
					Prerequisite: blocker.Prerequisite,
				})
			}

			return response
		}
	}

	if g.isMaintenance(plugin.Name) {
		response.State = "maintenance"
		response.RetryAfterSeconds = intPointer(2)

		return response
	}

	if *plugin.Manifest.Backend.Kind == manifest.BackendKindExec {
		response.State = "ready"

		return response
	}

	if *plugin.Manifest.Backend.Kind != manifest.BackendKindService || g.supervisor == nil {
		response.State = "unavailable"

		return response
	}

	requiredProtocol := 0

	if plugin.Manifest.Backend.ProtocolVersion != nil {
		requiredProtocol = *plugin.Manifest.Backend.ProtocolVersion
	}

	supportedProtocols := g.supervisor.SupportedProtocols()

	if plugin.Manifest.Backend.ProtocolVersion == nil || !supportsProtocol(requiredProtocol, supportedProtocols) {
		response.State = "incompatible"
		response.RequiredProtocol = intPointer(requiredProtocol)
		response.SupportedProtocols = &supportedProtocols

		return response
	}

	status := g.supervisor.Status(plugin.Name)

	switch status.State {
	case StateReady:
		response.State = "ready"
	case StateStarting, StateBackoff:
		response.State = "starting"
		response.RetryAfterSeconds = retryAfterSeconds(now, status.NextAttemptAt)
	case StateCapacityBlocked:
		response.State = "starting"
	case StateStopped, StateFailed:
		response.State = "unavailable"
	default:
		response.State = "unavailable"
	}

	return response
}

func intPointer(value int) *int {
	return &value
}

func (g *Gateway) handleStatus(writer http.ResponseWriter, request *http.Request) {
	writer = httpx.NewNoCORSResponseWriter(writer)

	writer.Header().Set("Cache-Control", "no-store")

	if !g.authenticate(writer, request) {
		return
	}

	plugin, found := g.registry.Resolve(request.PathValue("name"))

	if !found || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil {
		g.writeError(writer, httpx.NewError(http.StatusNotFound, httpx.CodeRouteNotFound, "no such backend route"))

		return
	}

	now := time.Now()

	if g.supervisor != nil && g.supervisor.cfg.Now != nil {
		now = g.supervisor.cfg.Now()
	}

	httpx.WriteJSON(writer, g.logger, http.StatusOK, g.projectBackendStatus(plugin, now))
}
