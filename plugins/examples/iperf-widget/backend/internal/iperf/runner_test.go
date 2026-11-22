package iperf

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestArgsOrder(t *testing.T) {
	options := Options{Host: "example.net", Port: 5201, Duration: 10, Streams: 4}
	want := []string{"-c", "example.net", "-p", "5201", "-t", "10", "-P", "4", "--json-stream"}

	if got := Args(options); !reflect.DeepEqual(got, want) {
		t.Fatalf("Args() = %#v, want %#v", got, want)
	}

	options.Reverse = true
	want = append(want, "-R")

	if got := Args(options); !reflect.DeepEqual(got, want) {
		t.Fatalf("Args(Reverse) = %#v, want %#v", got, want)
	}
}

func TestRunFakeBinary(t *testing.T) {
	fixture, err := filepath.Abs(filepath.Join("testdata", "download.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	binary := writeFakeBinary(t, "cat "+shellQuote(fixture))
	var events []Event
	err = Run(context.Background(), Options{Binary: binary, Host: "example.net", Port: 5201, Duration: 3, Streams: 2}, func(event Event) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatal(err)
	}

	intervals := 0
	ends := 0

	for _, event := range events {
		if event.Kind == EventInterval {
			intervals++
		}

		if event.Kind == EventEnd {
			ends++
		}
	}

	if intervals != 3 || ends != 1 {
		t.Fatalf("got %d intervals and %d end events from %#v", intervals, ends, events)
	}
}

func TestRunBusy(t *testing.T) {
	fixture, err := filepath.Abs(filepath.Join("testdata", "busy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	binary := writeFakeBinary(t, "cat "+shellQuote(fixture))
	err = Run(context.Background(), Options{Binary: binary, Host: "example.net", Port: 5201, Duration: 3, Streams: 2}, func(Event) {})
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("Run() error = %v, want ErrBusy", err)
	}
}

func TestRunMissingBinary(t *testing.T) {
	err := Run(context.Background(), Options{Binary: filepath.Join(t.TempDir(), "missing"), Host: "example.net"}, func(Event) {})
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("Run() error = %v, want ErrMissing", err)
	}
}

func TestRunCancelKills(t *testing.T) {
	line := `printf '{"event":"interval","data":{"sum":{"bits_per_second":1,"end":1}}}\n'; exec sleep 30`
	binary := writeFakeBinary(t, line)
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	events := make(chan Event, 1)
	result := make(chan error, 1)

	go func() {
		result <- Run(ctx, Options{Binary: binary, Host: "example.net", Port: 5201, Duration: 3, Streams: 2}, func(event Event) {
			events <- event
		})
	}()

	select {
	case event := <-events:
		if event.Kind != EventInterval {
			t.Fatalf("first event = %#v, want interval", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fake binary did not start")
	}

	cancel()

	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run() error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not stop after cancellation")
	}
}

func writeFakeBinary(t *testing.T, command string) string {
	t.Helper()

	binary := filepath.Join(t.TempDir(), "fake-iperf3")
	script := "#!/bin/sh\n" + command + "\n"

	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	return binary
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
