package persistent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

type Status struct {
	Status  string `json:"status"`
	Code    string `json:"code"`
	Ident   string `json:"ident"`
	Message string `json:"message"`
}

type Step struct {
	OK     bool     `json:"ok"`
	Status []Status `json:"status"`
}

func UnwrapStatus(body []byte, expectedSteps int) ([]Step, error) {
	steps := failedSteps(expectedSteps)

	if expectedSteps < 0 {
		return nil, fmt.Errorf("expected step count must not be negative")
	}

	trimmed := bytes.TrimSpace(body)

	if len(trimmed) == 0 || (trimmed[0] != '[' && trimmed[0] != '{') {
		return nil, fmt.Errorf("persistent response must be a JSON array or indexed object")
	}

	elements, err := responseElements(trimmed)
	if err != nil {
		return nil, err
	}

	if len(elements) > expectedSteps {
		return steps, nil
	}

	for index, element := range elements {
		if index >= expectedSteps {
			break
		}

		var value any

		if err := json.Unmarshal(element, &value); err != nil {
			continue
		}

		statuses := collectStatuses(value)

		if statuses == nil {
			continue
		}

		steps[index].Status = statuses
		steps[index].OK = len(statuses) > 0

		for _, status := range statuses {
			if status.Status == "error" {
				steps[index].OK = false

				break
			}
		}
	}

	return steps, nil
}

func responseElements(body []byte) ([]json.RawMessage, error) {
	if len(body) > 0 && body[0] == '[' {
		var elements []json.RawMessage

		if err := json.Unmarshal(body, &elements); err != nil {
			return nil, fmt.Errorf("persistent response is invalid JSON: %w", err)
		}

		return elements, nil
	}

	var indexed map[string]json.RawMessage

	if err := json.Unmarshal(body, &indexed); err != nil {
		return nil, fmt.Errorf("persistent response is invalid JSON: %w", err)
	}

	if len(indexed) == 0 {
		return nil, fmt.Errorf("persistent response must be a JSON array or indexed object")
	}

	indices := make([]int, 0, len(indexed))

	for key := range indexed {
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 {
			return nil, fmt.Errorf("persistent response object is not indexed")
		}

		indices = append(indices, index)
	}

	sort.Ints(indices)

	elements := make([]json.RawMessage, indices[len(indices)-1]+1)

	for _, index := range indices {
		elements[index] = indexed[strconv.Itoa(index)]
	}

	return elements, nil
}

func failedSteps(count int) []Step {
	if count <= 0 {
		return []Step{}
	}

	return make([]Step, count)
}

func collectStatuses(value any) []Status {
	var result []Status
	var visit func(any)
	visit = func(current any) {
		switch current := current.(type) {
		case map[string]any:
			if raw, ok := current["status"].([]any); ok {
				for _, item := range raw {
					object, ok := item.(map[string]any)

					if !ok {
						continue
					}

					status := Status{}

					if value, ok := object["status"].(string); ok {
						status.Status = value
					}

					if value, ok := object["code"].(string); ok {
						status.Code = value
					}

					if value, ok := object["ident"].(string); ok {
						status.Ident = value
					}

					if value, ok := object["message"].(string); ok {
						status.Message = value
					}

					result = append(result, status)
				}
			}

			for key, child := range current {
				if key != "status" {
					visit(child)
				}
			}
		case []any:
			for _, child := range current {
				visit(child)
			}
		}
	}

	visit(value)

	return result
}
