package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"

	"smart-page/internal/model"
	"smart-page/internal/monitor"
)

type handler struct {
	controller      *monitor.Controller
	pluginID        string
	protocolVersion int
}

type discoverRequest struct {
	AcknowledgeWake *bool `json:"acknowledgeWake"`
}

type refreshRequest struct {
	DeviceID        string `json:"deviceId"`
	AcknowledgeWake *bool  `json:"acknowledgeWake"`
}

type deviceTypeRequest struct {
	DeviceID   string          `json:"deviceId"`
	DeviceType json.RawMessage `json:"deviceType"`
}

func New(controller *monitor.Controller, pluginID string, protocolVersion int) http.Handler {
	api := &handler{
		controller:      controller,
		pluginID:        pluginID,
		protocolVersion: protocolVersion,
	}

	return http.HandlerFunc(api.serveHTTP)
}

func Readiness(pluginID string, protocolVersion int) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{
			"pluginId":        pluginID,
			"protocolVersion": protocolVersion,
		})
	})
}

func (api *handler) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")

	switch request.URL.Path {
	case "/_mndw/ready":
		if request.Method != http.MethodGet {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		Readiness(api.pluginID, api.protocolVersion).ServeHTTP(writer, request)
	case "/snapshot":
		if request.Method != http.MethodGet {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		body, err := EncodeSnapshot(api.controller.Snapshot())
		if err != nil {
			writeAPIError(writer, http.StatusInternalServerError, "internal-error")

			return
		}

		writer.WriteHeader(http.StatusOK)

		_, _ = writer.Write(body)
	case "/discover":
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		api.discover(writer, request)
	case "/refresh":
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		api.refresh(writer, request)
	case "/device-type":
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		api.setDeviceType(writer, request)
	case "/operation":
		if request.Method != http.MethodGet {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		api.operation(writer, request)
	default:
		writeAPIError(writer, http.StatusBadRequest, "bad-request")
	}
}

func (api *handler) discover(writer http.ResponseWriter, request *http.Request) {
	var body discoverRequest

	if !decodeRequest(writer, request, &body) || body.AcknowledgeWake == nil || !*body.AcknowledgeWake {
		writeAPIError(writer, http.StatusBadRequest, "bad-request")

		return
	}

	operation, err := api.controller.SubmitDiscover()
	if err != nil {
		writeAPIError(writer, monitor.StatusForAdmission(err), monitor.AdmissionCode(err))

		return
	}

	writeJSON(writer, http.StatusAccepted, model.AcceptedOperation{
		SchemaVersion: 1,
		OperationID:   operation.ID,
	})
}

func (api *handler) refresh(writer http.ResponseWriter, request *http.Request) {
	var body refreshRequest

	if !decodeRequest(writer, request, &body) || body.DeviceID == "" || body.AcknowledgeWake == nil || !*body.AcknowledgeWake {
		writeAPIError(writer, http.StatusBadRequest, "bad-request")

		return
	}

	operation, err := api.controller.SubmitRefresh(body.DeviceID)
	if err != nil {
		writeAPIError(writer, monitor.StatusForAdmission(err), monitor.AdmissionCode(err))

		return
	}

	writeJSON(writer, http.StatusAccepted, model.AcceptedOperation{
		SchemaVersion: 1,
		OperationID:   operation.ID,
	})
}

func (api *handler) setDeviceType(writer http.ResponseWriter, request *http.Request) {
	var body deviceTypeRequest

	if !decodeRequest(writer, request, &body) || body.DeviceID == "" || len(body.DeviceType) == 0 {
		writeAPIError(writer, http.StatusBadRequest, "bad-request")

		return
	}

	var deviceType *string

	if !bytes.Equal(bytes.TrimSpace(body.DeviceType), []byte("null")) {
		var value string

		if err := json.Unmarshal(body.DeviceType, &value); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "bad-request")

			return
		}

		deviceType = &value
	}

	response, err := api.controller.SetDeviceType(body.DeviceID, deviceType)
	if err != nil {
		writeAPIError(writer, monitor.StatusForAdmission(err), monitor.AdmissionCode(err))

		return
	}

	writeJSON(writer, http.StatusOK, response)
}

func (api *handler) operation(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	ids, hasID := query["id"]

	if len(query) != 1 || !hasID || len(ids) != 1 || ids[0] == "" {
		writeAPIError(writer, http.StatusBadRequest, "bad-request")

		return
	}

	operation, err := api.controller.Operation(ids[0])
	if err != nil {
		writeAPIError(writer, monitor.StatusForAdmission(err), monitor.AdmissionCode(err))

		return
	}

	writeJSON(writer, http.StatusOK, operation)
}

func decodeRequest(writer http.ResponseWriter, request *http.Request, value any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, model.MaxRequestBytes))
	if err != nil {
		return false
	}

	var fields map[string]json.RawMessage

	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return false
	}

	allowedFields := requestJSONFields(value)

	for name := range fields {
		if _, allowed := allowedFields[name]; !allowed {
			return false
		}
	}

	decoder := json.NewDecoder(bytes.NewReader(body))

	decoder.DisallowUnknownFields()

	if err := decoder.Decode(value); err != nil {
		return false
	}

	var trailing any

	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return false
	}

	return true
}

func requestJSONFields(value any) map[string]struct{} {
	requestType := reflect.TypeOf(value)

	if requestType == nil || requestType.Kind() != reflect.Pointer || requestType.Elem().Kind() != reflect.Struct {
		return nil
	}

	requestType = requestType.Elem()
	fields := make(map[string]struct{}, requestType.NumField())

	for index := range requestType.NumField() {
		field := requestType.Field(index)

		if field.PkgPath != "" {
			continue
		}

		name := field.Name

		if tag, tagged := field.Tag.Lookup("json"); tagged {
			name, _, _ = strings.Cut(tag, ",")

			if name == "-" {
				continue
			}

			if name == "" {
				name = field.Name
			}
		}

		fields[name] = struct{}{}
	}

	return fields
}

func writeAPIError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, model.APIError{
		SchemaVersion: 1,
		Error:         model.ErrorDetail{Code: model.Text(code)},
	})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)

	_ = json.NewEncoder(writer).Encode(value)
}
