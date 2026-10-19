package heartbeat

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestContractTypesCompile(t *testing.T) {
	var result Result
	var target Target

	if result.Status != 0 || target.Client != nil || target.Context != nil {
		t.Fatal("zero contract values changed")
	}

	target.Context = context.Background()
	target.Client = &http.Client{}
}

func TestProbeStatusPolicyAndCookieRefresh(t *testing.T) {
	for _, test := range []struct {
		name         string
		status       int
		body         string
		unauthorized bool
		transient    bool
	}{
		{name: "success", status: http.StatusOK, body: `[]`},
		{name: "unauthorized", status: http.StatusUnauthorized, body: `{}`, unauthorized: true},
		{name: "forbidden", status: http.StatusForbidden, body: `{}`, unauthorized: true},
		{name: "redirect", status: http.StatusFound, body: `{}`, transient: true},
		{name: "malformed", status: http.StatusOK, body: `not-json`, transient: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path != "/rci/" || request.Method != http.MethodPost {
					t.Fatalf("request = %s %s", request.Method, request.URL.Path)
				}

				body, _ := io.ReadAll(request.Body)

				if !bytes.Equal(body, []byte(`{"show":{"version":{}}}`)) {
					t.Fatalf("body = %s", body)
				}

				return &http.Response{StatusCode: test.status, Body: io.NopCloser(bytes.NewBufferString(test.body)), Header: make(http.Header)}, nil
			})}
			result := (Probe{Timeout: time.Second}).Run(context.Background(), client, "https://node.keenetic.io")

			if result.Unauthorized != test.unauthorized || result.Transient != test.transient {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestRunBoundedLimitsConcurrentProbes(t *testing.T) {
	var active atomic.Int32
	var maximum atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		current := active.Add(1)

		for {
			old := maximum.Load()

			if current <= old || maximum.CompareAndSwap(old, current) {
				break
			}
		}

		time.Sleep(time.Millisecond)
		active.Add(-1)

		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewBufferString(`[]`)), Header: make(http.Header)}, nil
	})}
	targets := make([]Target, 8)

	for index := range targets {
		targets[index] = Target{Identity: string(rune('a' + index)), Client: client, Context: WithBaseURL(context.Background(), "https://node.keenetic.io")}
	}

	var completed atomic.Int32

	RunBounded(context.Background(), targets, 3, Probe{Timeout: time.Second}, func(Target, Result) { completed.Add(1) })

	if completed.Load() != int32(len(targets)) || maximum.Load() > 3 {
		t.Fatalf("completed=%d maximum=%d", completed.Load(), maximum.Load())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }
