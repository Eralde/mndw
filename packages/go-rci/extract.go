package rci

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func Extract(raw json.RawMessage, path string) (json.RawMessage, error) {
	if err := validatePath(path); err != nil {
		return nil, err
	}

	current := raw
	for _, segment := range strings.Split(path, ".") {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(current, &object); err != nil {
			var typeErr *json.UnmarshalTypeError
			if errors.As(err, &typeErr) {
				return nil, nil
			}
			return nil, fmt.Errorf("%w: %w", ErrInvalidResponse, err)
		}
		if object == nil {
			return nil, nil
		}
		next, ok := object[segment]
		if !ok {
			return nil, nil
		}
		current = next
	}
	return current, nil
}
