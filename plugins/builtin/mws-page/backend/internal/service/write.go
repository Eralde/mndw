package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"mndw.local/rcisock"
	"mws-page/internal/persistent"
)

type WriteRequest struct {
	Operation string          `json:"operation"`
	NodeID    string          `json:"nodeId"`
	Params    json.RawMessage `json:"params"`
}

type WriteStep struct {
	Step   string              `json:"step"`
	OK     bool                `json:"ok"`
	Status []persistent.Status `json:"status"`
}

type WriteResult struct {
	OK    bool        `json:"ok"`
	Steps []WriteStep `json:"steps"`
}

type setPowerParams struct {
	Interface string          `json:"interface"`
	Power     json.RawMessage `json:"power"`
	Persist   *bool           `json:"persist"`
}

func (s *Service) Write(ctx context.Context, request WriteRequest) (WriteResult, error) {
	writer, ok := s.persistent.(interface {
		Send(context.Context, string, persistent.Request) (persistent.Response, error)
		HasTarget(string) bool
	})
	if !ok {
		return WriteResult{}, &OperationError{status: 503, code: "persistent_session_unavailable", message: "persistent RCI session unavailable", err: persistent.ErrNoSession}
	}

	if request.Operation != "wifi.set-power" {
		return WriteResult{}, writeBadRequest("unknown write operation")
	}

	if request.NodeID == "controller" || !validNodeID(request.NodeID) {
		return WriteResult{}, writeBadRequest("invalid node id")
	}

	if !writer.HasTarget(request.NodeID) {
		return WriteResult{}, writeBadRequest("target is not in the current mesh")
	}

	params, err := decodeSetPowerParams(request.Params)
	if err != nil {
		return WriteResult{}, writeBadRequest(err.Error())
	}

	if params.Interface != "WifiMaster0" && params.Interface != "WifiMaster1" {
		return WriteResult{}, writeBadRequest("interface must be WifiMaster0 or WifiMaster1")
	}

	var power int

	if err := json.Unmarshal(params.Power, &power); err != nil || power < 0 || power > 100 {
		return WriteResult{}, writeBadRequest("power must be an integer from 0 to 100")
	}

	persist := true

	if params.Persist != nil {
		persist = *params.Persist
	}

	body, expectedSteps, err := buildSetPowerRCI(params.Interface, power, persist)
	if err != nil {
		return WriteResult{}, &OperationError{status: 500, code: "operation_rejected", message: "could not construct write request", err: err}
	}

	response, err := writer.Send(ctx, request.NodeID, persistent.Request{Method: "POST", Path: "rci/", Body: body})
	if err != nil {
		return WriteResult{}, classifyWriteTransportError(err)
	}

	if response.Status != 200 {
		return WriteResult{}, &OperationError{status: 502, code: "device_write_failed", message: fmt.Sprintf("device returned HTTP %d", response.Status)}
	}

	steps, err := persistent.UnwrapStatus(response.Body, expectedSteps)
	if err != nil {
		return WriteResult{}, &OperationError{status: 502, code: "device_response_invalid", message: "device returned an invalid write response", err: err}
	}

	names := []string{"set-power"}

	if persist {
		names = append(names, "save")
	}

	result := WriteResult{OK: true, Steps: make([]WriteStep, len(names))}

	for index, name := range names {
		result.Steps[index] = WriteStep{Step: name, OK: steps[index].OK, Status: steps[index].Status}
		result.OK = result.OK && steps[index].OK
	}

	return result, nil
}

func decodeSetPowerParams(raw json.RawMessage) (setPowerParams, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return setPowerParams{}, errors.New("params are required")
	}

	var params setPowerParams
	decoder := json.NewDecoder(bytes.NewReader(raw))

	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&params); err != nil {
		return setPowerParams{}, errors.New("params must be a valid set-power object")
	}

	if err := ensureEOF(decoder); err != nil {
		return setPowerParams{}, errors.New("params must contain one JSON object")
	}

	if params.Interface == "" || len(params.Power) == 0 {
		return setPowerParams{}, errors.New("interface and power are required")
	}

	return params, nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any

	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("extra JSON value")
	}

	return nil
}

func buildSetPowerRCI(interfaceName string, power int, persist bool) ([]byte, int, error) {
	set := map[string]any{
		"interface": map[string]any{"name": interfaceName, "power": power},
	}
	commands := []any{set}

	if persist {
		commands = append(commands, map[string]any{
			"system": map[string]any{"configuration": map[string]any{"save": map[string]any{}}},
		})
	}

	body, err := json.Marshal(commands)

	return body, len(commands), err
}

func writeBadRequest(message string) error {
	return &OperationError{status: 400, code: "operation_rejected", message: message}
}

func classifyWriteTransportError(err error) error {
	if errors.Is(err, persistent.ErrNoSession) {
		return &OperationError{status: 503, code: "persistent_session_unavailable", message: "persistent RCI session unavailable", err: err}
	}

	var remote *rcisock.RemoteError

	if errors.As(err, &remote) && remote.Code == "write-not-permitted" {
		return &OperationError{status: 403, code: "write_not_permitted", message: "persistent RCI write permission is not granted", err: err}
	}

	if strings.Contains(err.Error(), "write not permitted") {
		return &OperationError{status: 403, code: "write_not_permitted", message: "persistent RCI write permission is not granted", err: err}
	}

	return &OperationError{status: 503, code: "persistent_session_unavailable", message: "persistent RCI session unavailable", err: err}
}
