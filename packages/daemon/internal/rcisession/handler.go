package rcisession

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/minter"
	"mndwd/internal/rcisession/model"
)

type Handler struct {
	service   *Service
	tester    ControllerTester
	generator minter.Generator
}

func NewHandler(service *Service, tester ControllerTester, generator minter.Generator) *Handler {
	return &Handler{service: service, tester: tester, generator: generator}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mndw/rci-session/capability", h.handleCapability)
	mux.HandleFunc("POST /api/mndw/rci-session/controller/test", h.handleControllerTest)
	mux.HandleFunc("POST /api/mndw/rci-session/controller", h.handleControllerSave)
	mux.HandleFunc("DELETE /api/mndw/rci-session/controller", h.handleControllerDelete)
	mux.HandleFunc("POST /api/mndw/rci-session/extenders/provision", h.handleProvision)
	mux.HandleFunc("GET /api/mndw/rci-session/extenders", h.handleCapability)
	mux.HandleFunc("DELETE /api/mndw/rci-session/extenders", h.handleExtendersDelete)
}

func (h *Handler) handleCapability(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}
	state, document := h.service.Capability()
	extenders := make([]ExtenderCapability, 0, len(document.Extenders))
	if h.service.enumerator != nil {
		if members, err := h.service.enumerator.List(r.Context()); err == nil {
			for _, member := range members {
				record, ok := document.Extenders[member.Identity]
				if !ok {
					continue
				}
				extenders = append(extenders, extenderCapability(member, record))
			}
		}
	}
	for identity, record := range document.Extenders {
		found := false
		for _, extender := range extenders {
			if extender.Identity == identity {
				found = true
				break
			}
		}
		if !found {
			extenders = append(extenders, extenderCapability(enumeration.Member{Identity: identity}, record))
		}
	}
	controller := ControllerCapability{Support: model.SupportUnknown}
	if document.Controller != nil {
		controller.Support = document.Controller.Support
		controller.LastCheckedAt = document.Controller.LastCheckedAt
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"store":      map[string]any{"state": state},
		"controller": controller,
		"extenders":  extenders,
	})
}

type ControllerCapability struct {
	Support       model.Support `json:"support"`
	LastCheckedAt *time.Time    `json:"lastCheckedAt,omitempty"`
}

type ExtenderCapability struct {
	Identity      string        `json:"identity"`
	Name          string        `json:"name"`
	Support       model.Support `json:"support"`
	LastCheckedAt *time.Time    `json:"lastCheckedAt,omitempty"`
	LastError     string        `json:"lastError,omitempty"`
}

func extenderCapability(member enumeration.Member, record model.TokenRecord) ExtenderCapability {
	return ExtenderCapability{Identity: member.Identity, Name: member.Name, Support: record.Support, LastCheckedAt: record.LastCheckedAt, LastError: record.LastError}
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

func (h *Handler) handleExtendersDelete(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}
	if r.ContentLength > 0 {
		writeSessionError(w, http.StatusBadRequest, httpx.CodeBadRequest, "request body is not allowed")
		return
	}
	if err := h.service.DeleteExtenders(); err != nil {
		writeSessionError(w, http.StatusInternalServerError, httpx.CodeInternal, "failed to clear extender sessions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"result": "cleared"})
}

func (h *Handler) handleProvision(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}
	var request struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		return
	}
	if h.generator == nil {
		writeSessionError(w, http.StatusBadGateway, httpx.CodeRCIDeviceUnreachable, "extender provisioning unavailable")
		return
	}
	outcomes, err := h.service.Provision(r.Context(), h.generator, minter.Credentials{Username: request.Username, Password: request.Password})
	response := make([]map[string]string, 0, len(outcomes))
	for _, outcome := range outcomes {
		item := map[string]string{"identity": outcome.Member.Identity}
		if outcome.Err == nil {
			item["support"] = string(outcome.Record.Support)
		} else {
			item["support"] = string(model.SupportUnknown)
		}
		response = append(response, item)
	}
	if err != nil && len(response) == 0 {
		writeSessionError(w, http.StatusBadGateway, httpx.CodeRCIDeviceUnreachable, "extender provisioning failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"extenders": response})
}

func (h *Handler) csrf(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("X-Mndw-Csrf") != "1" {
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
