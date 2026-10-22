package rcisession

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/sessionmanager"
)

type Handler struct {
	service *Service
	tester  ControllerTester
}

func NewHandler(service *Service, tester ControllerTester, _ ...any) *Handler {
	return &Handler{service: service, tester: tester}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mndw/rci-session/capability", h.handleCapability)
	mux.HandleFunc("POST /api/mndw/rci-session/controller/test", h.handleControllerTest)
	mux.HandleFunc("POST /api/mndw/rci-session/controller", h.handleControllerSave)
	mux.HandleFunc("DELETE /api/mndw/rci-session/controller", h.handleControllerDelete)
	mux.HandleFunc("PUT /api/mndw/rci-session/enabled", h.handleEnabled)
	mux.HandleFunc("/api/mndw/rci-session/extenders", h.handleExtenders)
}

func BodyLimit(limit int64) func(http.Handler) http.Handler {
	if limit <= 0 {
		limit = 4096
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body == nil {
				next.ServeHTTP(w, r)

				return
			}

			if r.ContentLength > limit {
				writeSessionError(w, http.StatusRequestEntityTooLarge, httpx.CodeBadRequest, "request body is too large")

				return
			}

			body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
			if err != nil {
				writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "request body could not be read")

				return
			}

			if int64(len(body)) > limit {
				writeSessionError(w, http.StatusRequestEntityTooLarge, httpx.CodeBadRequest, "request body is too large")

				return
			}

			r.Body = io.NopCloser(bytes.NewReader(body))

			next.ServeHTTP(w, r)
		})
	}
}

func (h *Handler) handleExtenders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)

		return
	}

	h.handleCapability(w, r)
}

func (h *Handler) handleCapability(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	h.service.DetectAuthMode(r.Context())

	state, document := h.service.Capability()
	extenders := make([]ExtenderCapability, 0)

	if manager := h.service.SessionManager(); manager != nil {
		snapshot := manager.Snapshot()
		extenders = make([]ExtenderCapability, 0, len(snapshot.Members))

		for _, member := range snapshot.Members {
			entry := ExtenderCapability{
				Identity: member.Identity,
				Name:     member.Name,
				Eligible: member.Eligible,
			}

			if !member.Eligible {
				entry.Reason = member.Reason
			} else {
				entry.State = member.State

				if member.HasSession {
					entry.LastError = string(member.LastError)
					entry.LastHeartbeatAt = member.LastHeartbeatAt
				}
			}

			extenders = append(extenders, entry)
		}
	}

	mode := h.service.AuthMode()
	controller := ControllerCapability{Support: h.service.ControllerSupport(), Auth: mode, Enabled: h.service.Enabled()}

	if mode == AuthModeToken && document.Controller != nil {
		controller.LastCheckedAt = document.Controller.LastCheckedAt
	}

	report := map[string]any{
		"store":      map[string]any{"state": state},
		"controller": controller,
		"extenders":  extenders,
		"stale":      false,
	}

	if enumerator, ok := h.service.enumerator.(interface {
		Status() enumeration.CacheStatus
	}); ok {
		cacheStatus := enumerator.Status()
		report["stale"] = cacheStatus.Stale

		if cacheStatus.LastError != "" {
			report["lastEnumerationError"] = cacheStatus.LastError
		}

		if cacheStatus.LastErrorAt != nil {
			report["lastEnumerationErrorAt"] = cacheStatus.LastErrorAt
		}
	}

	writeJSON(w, http.StatusOK, report)
}

type ControllerCapability struct {
	Auth          AuthMode      `json:"auth"`
	Enabled       bool          `json:"enabled"`
	Support       model.Support `json:"support"`
	LastCheckedAt *time.Time    `json:"lastCheckedAt,omitempty"`
}

type ExtenderCapability struct {
	Identity        string               `json:"identity"`
	Name            string               `json:"name"`
	Eligible        bool                 `json:"eligible"`
	Reason          string               `json:"reason,omitempty"`
	State           sessionmanager.State `json:"state,omitempty"`
	LastError       string               `json:"lastError,omitempty"`
	LastHeartbeatAt *time.Time           `json:"lastHeartbeatAt,omitempty"`
}

func (h *Handler) handleControllerTest(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	var request struct {
		Token string `json:"token"`
	}

	if err := decodeJSON(w, r, &request); err != nil {
		return
	}

	verdict, _ := h.service.TestController(r.Context(), h.tester, request.Token)

	writeJSON(w, http.StatusOK, map[string]string{"result": string(verdict)})
}

func (h *Handler) handleControllerSave(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	var request struct {
		Token string `json:"token"`
	}

	if err := decodeJSON(w, r, &request); err != nil {
		return
	}

	verdict, err := h.service.SaveController(r.Context(), h.tester, request.Token)
	if err != nil && verdict == ControllerUnreachable {
		writeSessionError(w, http.StatusBadGateway, httpx.CodeRCIDeviceUnreachable, "controller is unreachable")

		return
	}

	if verdict == ControllerInvalidToken {
		writeSessionError(w, http.StatusUnprocessableEntity, httpx.CodeRCITokenInvalid, "controller token rejected")

		return
	}

	if verdict == ControllerUnsupported {
		writeSessionError(w, http.StatusUnprocessableEntity, httpx.CodeRCIFirmwareUnsupported, "controller firmware does not support token sessions")

		return
	}

	if verdict != ControllerValid {
		writeSessionError(w, http.StatusBadGateway, httpx.CodeRCIDeviceUnreachable, "controller is unreachable")

		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"result": string(verdict)})
}

func (h *Handler) handleControllerDelete(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	if r.ContentLength > 0 {
		writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "request body is not allowed")

		return
	}

	if err := h.service.DeleteController(); err != nil {
		writeSessionError(w, http.StatusInternalServerError, httpx.CodeInternal, "failed to clear controller session")

		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"result": "cleared"})
}

func (h *Handler) handleEnabled(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	var request struct {
		Enabled *bool `json:"enabled"`
	}

	if err := decodeJSON(w, r, &request); err != nil {
		return
	}

	if request.Enabled == nil {
		writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "enabled must be a boolean")

		return
	}

	verdict, err := h.service.SetTokenlessEnabled(r.Context(), h.tester, *request.Enabled)
	if errors.Is(err, ErrAuthModeMismatch) {
		writeSessionError(w, http.StatusConflict, httpx.CodeRCIAuthModeMismatch, "controller auth mode does not support tokenless sessions")

		return
	}

	if err != nil || verdict == ControllerUnreachable {
		writeSessionError(w, http.StatusBadGateway, httpx.CodeRCIDeviceUnreachable, "controller is unreachable")

		return
	}

	if verdict == ControllerInvalidToken || verdict == ControllerUnsupported {
		writeSessionError(w, http.StatusUnprocessableEntity, httpx.CodeRCIFirmwareUnsupported, "controller firmware does not support tokenless sessions")

		return
	}

	if verdict != ControllerValid {
		writeSessionError(w, http.StatusBadGateway, httpx.CodeRCIDeviceUnreachable, "controller is unreachable")

		return
	}

	result := "disabled"

	if *request.Enabled {
		result = "enabled"
	}

	writeJSON(w, http.StatusOK, map[string]string{"result": result})
}

func (h *Handler) csrf(w http.ResponseWriter, r *http.Request) bool {
	if !httpx.CSRFPresent(r) {
		writeSessionError(w, http.StatusForbidden, httpx.CodeCsrfRequired, "CSRF header required")

		return false
	}

	return true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "JSON content type required")

		return io.EOF
	}

	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))

	decoder.DisallowUnknownFields()

	if err := decoder.Decode(destination); err != nil {
		writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "invalid JSON body")

		return err
	}

	var extra any

	if err := decoder.Decode(&extra); err != io.EOF {
		writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "request must contain one JSON value")

		return err
	}

	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	httpx.WriteJSON(w, nil, status, body)
}

func writeSessionError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	httpx.WriteError(w, nil, httpx.NewError(status, code, message))
}
