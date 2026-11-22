package probe

import (
	"context"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"

	"iperf-widget/internal/iperf"
)

func TestMeasureLocalListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer listener.Close()

	host, rawPort, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}

	pingMs, jitterMs, err := Measure(context.Background(), host, port, 5, 0, 100*time.Millisecond, nil)
	if err != nil {
		t.Fatal(err)
	}

	if pingMs < 0 || jitterMs < 0 {
		t.Fatalf("Measure() = ping %v ms, jitter %v ms; both must be non-negative", pingMs, jitterMs)
	}
}

func TestMeasurePacedSamples(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer listener.Close()

	go func() {
		for {
			connection, acceptErr := listener.Accept()

			if acceptErr != nil {
				return
			}

			_ = connection.Close()
		}
	}()

	port := listener.Addr().(*net.TCPAddr).Port
	const samples = 10
	interval := 20 * time.Millisecond
	started := time.Now()
	indices := make([]int, 0, samples)
	_, _, err = Measure(context.Background(), "127.0.0.1", port, samples, interval, 100*time.Millisecond,
		func(index int, ms float64, ok bool) {
			indices = append(indices, index)

			if !ok || ms < 0 {
				t.Errorf("sample %d = %.2fms, ok %v", index, ms, ok)
			}
		})
	if err != nil {
		t.Fatal(err)
	}

	if len(indices) != samples || time.Since(started) < 9*interval {
		t.Fatalf("got indices %v in %v, want 10 samples over at least %v", indices, time.Since(started), 9*interval)
	}

	for index, got := range indices {
		if got != index {
			t.Fatalf("sample index %d = %d", index, got)
		}
	}
}

func TestMeasureCancelledStopsSampling(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer listener.Close()

	go func() {
		for {
			connection, acceptErr := listener.Accept()

			if acceptErr != nil {
				return
			}

			_ = connection.Close()
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	samples := 0
	_, _, err = Measure(ctx, "127.0.0.1", listener.Addr().(*net.TCPAddr).Port, 10, 20*time.Millisecond, 100*time.Millisecond,
		func(_ int, _ float64, _ bool) {
			samples++

			if samples == 2 {
				cancel()
			}
		})
	if !errors.Is(err, context.Canceled) || samples != 2 {
		t.Fatalf("Measure() = %d callbacks, %v; want 2 callbacks and cancellation", samples, err)
	}
}

func TestMeasureStats(t *testing.T) {
	samples := []time.Duration{10 * time.Millisecond, 12 * time.Millisecond, 11 * time.Millisecond, 15 * time.Millisecond, 10 * time.Millisecond}
	median, jitter := stats(samples)

	if median != 11*time.Millisecond || jitter != 3*time.Millisecond {
		t.Fatalf("stats() = median %v, jitter %v; want 11ms and 3ms", median, jitter)
	}
}

func TestMeasureUnreachable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	address := listener.Addr().(*net.TCPAddr)

	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	callbacks := 0
	_, _, err = Measure(context.Background(), "127.0.0.1", address.Port, 2, 0, 100*time.Millisecond,
		func(_ int, _ float64, ok bool) {
			callbacks++

			if ok {
				t.Error("closed port sample unexpectedly succeeded")
			}
		})
	if !errors.Is(err, iperf.ErrUnreachable) {
		t.Fatalf("Measure() error = %v, want ErrUnreachable", err)
	}

	if callbacks != 2 {
		t.Fatalf("got %d sample callbacks, want 2 failed samples", callbacks)
	}
}

func TestMeasureUnresolvable(t *testing.T) {
	_, _, err := Measure(context.Background(), "no-such-host.invalid", 5201, 2, 0, 100*time.Millisecond, nil)
	if !errors.Is(err, iperf.ErrUnreachable) {
		t.Fatalf("Measure() error = %v, want ErrUnreachable", err)
	}
}

func TestMeasureResolvesOnceBeforeSamples(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer listener.Close()

	go func() {
		for {
			connection, acceptErr := listener.Accept()

			if acceptErr != nil {
				return
			}

			_ = connection.Close()
		}
	}()

	port := listener.Addr().(*net.TCPAddr).Port
	lookedUp := false
	lookup := func(context.Context, string) ([]net.IPAddr, error) {
		if lookedUp {
			return nil, errors.New("lookup called more than once")
		}

		lookedUp = true

		return []net.IPAddr{
			{IP: net.ParseIP("127.0.0.1")},
			{IP: net.ParseIP("127.0.0.2")},
		}, nil
	}

	_, _, err = measure(context.Background(), "probe.example", port, 5, 0, 100*time.Millisecond, nil, lookup)
	if err != nil {
		t.Fatalf("measure() error = %v", err)
	}
}
