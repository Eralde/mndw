package persistent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"mndw.local/rci"
)

type PowerState struct {
	Value     *int `json:"value,omitempty"`
	Available bool `json:"available"`
}

func parseInterfacePower(raw json.RawMessage, interfaceName string) (PowerState, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return PowerState{}, fmt.Errorf("interface response is empty")
	}

	var interfaces map[string]json.RawMessage

	if err := json.Unmarshal(raw, &interfaces); err != nil {
		if _, ok := err.(*json.SyntaxError); ok {
			return PowerState{}, fmt.Errorf("parse interface response: %w", err)
		}

		return availablePower(100), nil
	}

	interfaceRaw, ok := interfaces[interfaceName]

	if !ok {
		return availablePower(100), nil
	}

	var fields map[string]json.RawMessage

	if err := json.Unmarshal(interfaceRaw, &fields); err != nil {
		return availablePower(100), nil
	}

	powerRaw, ok := fields["power"]

	if !ok {
		return availablePower(100), nil
	}

	value, ok := parsePowerValue(powerRaw)

	if !ok {
		return availablePower(100), nil
	}

	return availablePower(value), nil
}

func parsePowerValue(raw json.RawMessage) (int, bool) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))

	decoder.UseNumber()

	if err := decoder.Decode(&value); err != nil {
		return 0, false
	}

	switch value := value.(type) {
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(value))

		if err != nil || parsed < 0 || parsed > 100 {
			return 0, false
		}

		return parsed, true
	case json.Number:
		parsed, err := strconv.ParseFloat(string(value), 64)

		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed != math.Trunc(parsed) || parsed < 0 || parsed > 100 {
			return 0, false
		}

		return int(parsed), true
	default:
		return 0, false
	}
}

func availablePower(value int) PowerState {
	return PowerState{Value: intPointer(value), Available: true}
}

func unavailablePower(previous PowerState) PowerState {
	return PowerState{Value: cloneIntPointer(previous.Value), Available: false}
}

func intPointer(value int) *int {
	return &value
}

func cloneIntPointer(value *int) *int {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}

func (c *Client) pollInterfacePower(ctx context.Context, requester Requester, target Target) {
	markBothPowerUnavailable := func() {
		c.store.updatePowerState(target.Identity, func(state *sessionState) {
			state.power2G = unavailablePower(state.power2G)
			state.power5G = unavailablePower(state.power5G)
		})
	}

	var reply Response
	var transportErr error
	send := rci.TransportFunc(func(requestCtx context.Context, body []byte) (rci.Response, error) {
		reply, transportErr = requester.Do(requestCtx, Request{Method: http.MethodPost, Path: "rci/", Body: body})

		return rci.Response{Status: reply.Status, Body: reply.Body}, transportErr
	})
	client, err := rci.New(send)
	if err != nil {
		markBothPowerUnavailable()

		return
	}

	responses, err := client.ExecuteMany(ctx,
		rci.Q("show.sc.interface", map[string]any{"name": "WifiMaster0"}),
		rci.Q("show.sc.interface", map[string]any{"name": "WifiMaster1"}),
	)
	if err != nil {
		markBothPowerUnavailable()

		return
	}

	for index, interfaceName := range []string{"WifiMaster0", "WifiMaster1"} {
		if index >= len(responses) || responses[index] == nil {
			c.store.markPowerUnavailable(target.Identity, index)

			continue
		}

		state, parseErr := parseInterfacePower(responses[index], interfaceName)

		if parseErr != nil {
			c.store.markPowerUnavailable(target.Identity, index)

			continue
		}

		c.store.setPowerState(target.Identity, index, state)
	}
}
