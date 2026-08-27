package rci

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
)

type Client struct {
	transport Transport
}

func New(transport Transport) (*Client, error) {
	if isNilTransport(transport) {
		return nil, ErrNilTransport
	}
	return &Client{transport: transport}, nil
}

func isNilTransport(transport Transport) bool {
	if transport == nil {
		return true
	}
	value := reflect.ValueOf(transport)
	switch value.Kind() {
	case reflect.Ptr, reflect.Map, reflect.Slice, reflect.Chan,
		reflect.Func, reflect.UnsafePointer, reflect.Interface:
		return value.IsNil()
	default:
		return false
	}
}

func (c *Client) Execute(ctx context.Context, query Query) (json.RawMessage, error) {
	values, err := c.ExecuteMany(ctx, query)
	if err != nil {
		return nil, err
	}
	return values[0], nil
}

func (c *Client) ExecuteMany(ctx context.Context, queries ...Query) ([]json.RawMessage, error) {
	values, _, err := c.executeMany(ctx, queries...)
	return values, err
}

func (c *Client) ExecuteRaw(ctx context.Context, queries ...Query) ([]json.RawMessage, []byte, error) {
	return c.executeMany(ctx, queries...)
}

func (c *Client) executeMany(ctx context.Context, queries ...Query) ([]json.RawMessage, []byte, error) {
	if len(queries) == 0 {
		return make([]json.RawMessage, 0), nil, nil
	}

	wireQueries := make([][]byte, len(queries))
	for index, query := range queries {
		if err := validatePath(query.Path); err != nil {
			return nil, nil, &QueryError{Index: index, Path: query.Path, Err: err}
		}
		wire, err := marshalQuery(query)
		if err != nil {
			return nil, nil, &QueryError{Index: index, Path: query.Path, Err: err}
		}
		wireQueries[index] = wire
	}

	compacted := compactWireQueries(wireQueries)
	requestBody, err := marshalWireArray(compacted.wire)
	if err != nil {
		return nil, nil, fmt.Errorf("rci: marshal request: %w", err)
	}
	response, err := c.transport.Send(ctx, requestBody)
	if err != nil {
		return nil, nil, fmt.Errorf("rci: send: %w", err)
	}

	if response.Status != 200 {
		return nil, response.Body, &HTTPError{
			StatusCode: response.Status,
			Status:     strconv.Itoa(response.Status),
			Body:       truncateHTTPErrorBody(response.Body),
		}
	}

	uniqueResults, err := decodeResponse(response.Body)
	if err != nil {
		return nil, response.Body, err
	}
	results := inflateResults(uniqueResults, compacted.positions, len(queries))
	for index, query := range queries {
		if query.Raw || results[index] == nil {
			continue
		}
		result, err := Extract(results[index], query.Path)
		if err != nil {
			return nil, response.Body, err
		}
		results[index] = result
	}
	return results, response.Body, nil
}

func marshalWireArray(wireQueries [][]byte) ([]byte, error) {
	entries := make([]json.RawMessage, len(wireQueries))
	for index, wire := range wireQueries {
		entries[index] = json.RawMessage(wire)
	}
	return json.Marshal(entries)
}

func decodeResponse(body []byte) ([]json.RawMessage, error) {
	var results []json.RawMessage
	if err := json.Unmarshal(body, &results); err != nil {
		return nil, invalidResponseError(err)
	}
	if bytes.Equal(bytes.TrimSpace(body), []byte("null")) {
		return nil, fmt.Errorf("%w: response must be a JSON array", ErrInvalidResponse)
	}
	return results, nil
}

func invalidResponseError(err error) error {
	return fmt.Errorf("%w: %w", ErrInvalidResponse, err)
}

func truncateHTTPErrorBody(body []byte) []byte {
	if len(body) > 4<<10 {
		body = body[:4<<10]
	}
	return append([]byte(nil), body...)
}
