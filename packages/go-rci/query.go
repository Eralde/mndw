package rci

import (
	"encoding/json"
	"strings"
)

type Query struct {
	Path string
	Data any
	Raw  bool
}

func Q(path string, data ...any) Query {
	if len(data) > 1 {
		panic("rci: Q accepts at most one data argument")
	}

	var value any

	if len(data) == 1 {
		value = data[0]
	}

	return Query{Path: path, Data: value}
}

func validatePath(path string) error {
	if path == "" {
		return ErrInvalidPath
	}

	for _, segment := range strings.Split(path, ".") {
		if segment == "" {
			return ErrInvalidPath
		}
	}

	return nil
}

func marshalQuery(query Query) ([]byte, error) {
	data := query.Data

	if data == nil {
		data = map[string]any{}
	}

	root := make(map[string]any)
	current := root
	segments := strings.Split(query.Path, ".")

	for index, segment := range segments {
		if index == len(segments)-1 {
			current[segment] = data

			break
		}

		next := make(map[string]any)
		current[segment] = next
		current = next
	}

	return json.Marshal(root)
}
