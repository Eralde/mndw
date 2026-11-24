package events

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type hookEventPublisher struct{ events []Event }

func (p *hookEventPublisher) Publish(event Event) { p.events = append(p.events, event) }

func TestHookHandlerRejectsNonLoopback(t *testing.T) {
	handler := NewHookHandler(NewBus(), fixedNormalizer())
	request := httptest.NewRequest("POST", "/_internal/hook", strings.NewReader(`{"hook":"button.d","payload":{"button":"reset","action":"short"}}`))
	request.RemoteAddr = "192.0.2.10:1234"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != 403 {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
}

func TestHookHandlerPublishesLoopbackRequestAndRejectsTrailingJSON(t *testing.T) {
	publisher := &hookEventPublisher{}
	handler := NewHookHandler(publisher, fixedNormalizer())

	request := httptest.NewRequest("POST", "/_internal/hook", strings.NewReader(`{"hook":"button.d","payload":{"button":"reset","action":"short"}}`))
	request.RemoteAddr = "127.0.0.1:1234"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != 204 || len(publisher.events) != 1 {
		t.Fatalf("valid hook response = %d, events = %d", recorder.Code, len(publisher.events))
	}

	trailing := httptest.NewRequest("POST", "/_internal/hook", strings.NewReader(`{"hook":"button.d","payload":{"button":"reset","action":"short"}} {}`))
	trailing.RemoteAddr = "127.0.0.1:1234"
	trailingRecorder := httptest.NewRecorder()

	handler.ServeHTTP(trailingRecorder, trailing)

	if trailingRecorder.Code != 400 || len(publisher.events) != 1 {
		t.Fatalf("trailing JSON response = %d, events = %d", trailingRecorder.Code, len(publisher.events))
	}
}

func TestHookHandlerMatchesContractGoldens(t *testing.T) {
	files, err := filepath.Glob("hookfixtures/*.json")
	if err != nil {
		t.Fatal(err)
	}

	if len(files) == 0 {
		t.Fatal("hook contract fixtures are missing")
	}

	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			contents, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}

			var golden struct {
				Name  string          `json:"name"`
				Body  json.RawMessage `json:"body"`
				Event struct {
					Topic   string          `json:"topic"`
					Payload json.RawMessage `json:"payload"`
				} `json:"event"`
			}

			if err := json.Unmarshal(contents, &golden); err != nil {
				t.Fatal(err)
			}

			publisher := &hookEventPublisher{}
			handler := NewHookHandler(publisher, fixedNormalizer())
			request := httptest.NewRequest(http.MethodPost, "/_internal/hook", bytes.NewReader(golden.Body))
			request.RemoteAddr = "127.0.0.1:1234"
			recorder := httptest.NewRecorder()

			handler.ServeHTTP(recorder, request)

			if recorder.Code != http.StatusNoContent || len(publisher.events) != 1 {
				t.Fatalf("hook %q response = %d, published events = %d", golden.Name, recorder.Code, len(publisher.events))
			}

			event := publisher.events[0]

			if string(event.Topic) != golden.Event.Topic {
				t.Fatalf("hook %q topic = %q, want %q", golden.Name, event.Topic, golden.Event.Topic)
			}

			var actualPayload any
			var expectedPayload any

			if err := json.Unmarshal(event.Payload, &actualPayload); err != nil {
				t.Fatal(err)
			}

			if err := json.Unmarshal(golden.Event.Payload, &expectedPayload); err != nil {
				t.Fatal(err)
			}

			if !reflect.DeepEqual(actualPayload, expectedPayload) {
				t.Fatalf("hook %q payload = %#v, want %#v", golden.Name, actualPayload, expectedPayload)
			}
		})
	}
}
