package events

import (
	"net/http/httptest"
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
