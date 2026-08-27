package rcisock

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestFrameWireKeys(t *testing.T) {
	zero := int64(42)
	request := RequestFrame{
		Hello:  &ClientHello{PluginID: "plugin", Proto: ProtocolVersion},
		ID:     zero,
		Op:     "request",
		Target: "target",
		Method: "GET",
		Path:   "/rci/show/version",
		Body:   json.RawMessage(`{"request":true}`),
	}
	response := ResponseFrame{
		Hello:   &ServerHello{Proto: ProtocolVersion, OK: true},
		ID:      &zero,
		Status:  200,
		Body:    json.RawMessage(`{"response":true}`),
		Targets: []Target{{Identity: "identity", Name: "name", MAC: "aa:bb:cc:dd:ee:ff"}},
		Error:   &Error{Code: "code", Message: "message"},
	}

	requestValue := marshalJSON(t, request)
	responseValue := marshalJSON(t, response)

	assertKeys(t, requestValue, []string{"body", "hello", "id", "method", "op", "path", "target"})
	assertKeys(t, responseValue, []string{"body", "error", "hello", "id", "status", "targets"})
	assertKeys(t, requestValue["hello"], []string{"pluginId", "proto"})
	assertKeys(t, responseValue["hello"], []string{"ok", "proto"})
	assertKeys(t, responseValue["error"], []string{"code", "message"})
	assertKeys(t, responseValue["targets"].([]any)[0], []string{"identity", "mac", "name"})
}

func TestResponseIDPresence(t *testing.T) {
	zero := int64(0)
	withZero := marshalJSON(t, ResponseFrame{ID: &zero})
	withoutID := marshalJSON(t, ResponseFrame{})

	if got := string(withZero["id"].(json.Number)); got != "0" {
		t.Fatalf("id = %q, want 0", got)
	}
	if _, ok := withoutID["id"]; ok {
		t.Fatalf("nil response ID was marshaled: %v", withoutID)
	}
}

func TestResponsePresence(t *testing.T) {
	zero := int64(1)
	emptyTargets := marshalJSON(t, ResponseFrame{ID: &zero, Targets: []Target{}})
	zeroStatus := marshalJSON(t, ResponseFrame{ID: &zero, Status: 0, Body: json.RawMessage(`{}`)})
	hello := marshalJSON(t, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}})

	targets, ok := emptyTargets["targets"].([]any)
	if !ok || targets == nil || len(targets) != 0 {
		t.Fatalf("targets = %#v, want non-nil empty array", emptyTargets["targets"])
	}
	if got := string(zeroStatus["status"].(json.Number)); got != "0" {
		t.Fatalf("status = %q, want 0", got)
	}
	if _, ok := hello["targets"]; ok {
		t.Fatalf("hello unexpectedly included targets: %v", hello)
	}
	if _, ok := hello["status"]; ok {
		t.Fatalf("hello unexpectedly included status: %v", hello)
	}
}

func TestDirectionTypedDecodeRejectsIllegalKeys(t *testing.T) {
	requestOnlyRejects := []string{
		`{"status":0}`,
		`{"targets":null}`,
		`{"error":null}`,
		`{"hello":{"ok":true}}`,
	}
	for _, raw := range requestOnlyRejects {
		t.Run("request rejects "+raw, func(t *testing.T) {
			if err := strictDecode(raw, &RequestFrame{}); err == nil {
				t.Fatalf("RequestFrame accepted illegal key in %s", raw)
			}
		})
	}

	responseOnlyRejects := []string{
		`{"op":"request"}`,
		`{"target":"target"}`,
		`{"method":"GET"}`,
		`{"path":"/"}`,
		`{"hello":{"pluginId":"plugin"}}`,
	}
	for _, raw := range responseOnlyRejects {
		t.Run("response rejects "+raw, func(t *testing.T) {
			if err := strictDecode(raw, &ResponseFrame{}); err == nil {
				t.Fatalf("ResponseFrame accepted illegal key in %s", raw)
			}
		})
	}
}

func TestReaderReassemblesSplitFrame(t *testing.T) {
	reader := NewReader[RequestFrame](&splitReader{chunks: [][]byte{
		[]byte(`{"id":`),
		[]byte(`7,"op":"targets"}` + "\n"),
	}}, 64)

	frame, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if frame.ID != 7 || frame.Op != "targets" {
		t.Fatalf("frame = %+v", frame)
	}
}

func TestReaderBoundsOneFrameNotCombinedRead(t *testing.T) {
	data := []byte(`{"id":1}` + "\n" + `{"id":2}` + "\n")
	reader := NewReader[RequestFrame](bytes.NewReader(data), len(`{"id":1}`)+1)

	first, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	second, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != 1 || second.ID != 2 {
		t.Fatalf("frames = %+v, %+v", first, second)
	}
}

func TestReaderRejectsOversizedFrame(t *testing.T) {
	reader := NewReader[RequestFrame](strings.NewReader(`{"id":123456}`), 5)
	if _, err := reader.Next(); err == nil {
		t.Fatal("oversized unterminated frame was accepted")
	} else if !errors.Is(err, ErrMalformedFrame) {
		t.Fatalf("oversized frame error = %v, want ErrMalformedFrame", err)
	}
}

func TestReaderRejectsMalformedFrame(t *testing.T) {
	reader := NewReader[RequestFrame](strings.NewReader(`{"status":0}`+"\n"), 64)
	if _, err := reader.Next(); !errors.Is(err, ErrMalformedFrame) {
		t.Fatalf("malformed frame error = %v, want ErrMalformedFrame", err)
	}
}

func TestReaderPassesThroughTransportError(t *testing.T) {
	transportErr := errors.New("transport failed")
	reader := NewReader[RequestFrame](&errorReader{err: transportErr}, 64)
	if _, err := reader.Next(); !errors.Is(err, transportErr) || errors.Is(err, ErrMalformedFrame) {
		t.Fatalf("transport error = %v, want unchanged transport error", err)
	}
}

func TestWriteFrameReportsShortWrite(t *testing.T) {
	err := WriteFrame(&shortWriter{}, RequestFrame{ID: 1})
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("WriteFrame error = %v, want io.ErrShortWrite", err)
	}
}

func marshalJSON(t *testing.T, value any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assertKeys(t *testing.T, value any, want []string) {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("value = %#v, want object", value)
	}
	got := make([]string, 0, len(object))
	for key := range object {
		got = append(got, key)
	}
	if !reflect.DeepEqual(sortedStrings(got), sortedStrings(want)) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
}

func strictDecode(raw string, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(destination)
}

func sortedStrings(values []string) []string {
	result := append([]string(nil), values...)
	for index := 0; index < len(result); index++ {
		for next := index + 1; next < len(result); next++ {
			if result[next] < result[index] {
				result[index], result[next] = result[next], result[index]
			}
		}
	}
	return result
}

type splitReader struct {
	chunks [][]byte
}

func (r *splitReader) Read(destination []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := r.chunks[0]
	r.chunks = r.chunks[1:]
	return copy(destination, chunk), nil
}

type shortWriter struct{}

func (*shortWriter) Write(data []byte) (int, error) {
	return len(data) - 1, nil
}

type errorReader struct {
	err error
}

func (r *errorReader) Read([]byte) (int, error) {
	return 0, r.err
}
