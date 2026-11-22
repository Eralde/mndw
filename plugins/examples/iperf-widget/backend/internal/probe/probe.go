package probe

import (
	"context"
	"net"
	"sort"
	"strconv"
	"time"

	"iperf-widget/internal/iperf"
)

func Measure(ctx context.Context, host string, port, samples int, interval, timeout time.Duration,
	onSample func(index int, ms float64, ok bool),
) (pingMs, jitterMs float64, err error) {
	return measure(ctx, host, port, samples, interval, timeout, onSample, net.DefaultResolver.LookupIPAddr)
}

func measure(ctx context.Context, host string, port, samples int, interval, timeout time.Duration,
	onSample func(index int, ms float64, ok bool),
	lookup func(context.Context, string) ([]net.IPAddr, error),
) (pingMs, jitterMs float64, err error) {
	if samples <= 0 {
		return 0, 0, iperf.ErrUnreachable
	}

	lookupContext, cancelLookup := context.WithTimeout(ctx, timeout)
	addresses, lookupErr := lookup(lookupContext, host)

	cancelLookup()

	if ctx.Err() != nil {
		return 0, 0, ctx.Err()
	}

	if lookupErr != nil || len(addresses) == 0 || addresses[0].IP == nil {
		return 0, 0, iperf.ErrUnreachable
	}

	dialer := &net.Dialer{}
	address := net.JoinHostPort(addresses[0].String(), strconv.Itoa(port))
	measurements := make([]time.Duration, 0, samples)
	var previousStart time.Time

	for index := range samples {
		if ctx.Err() != nil {
			return 0, 0, ctx.Err()
		}

		if index > 0 {
			wait := time.Until(previousStart.Add(interval))

			if wait > 0 {
				timer := time.NewTimer(wait)

				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()

					return 0, 0, ctx.Err()
				}
			}
		}

		started := time.Now()
		previousStart = started
		probeContext, cancel := context.WithTimeout(ctx, timeout)
		connection, dialErr := dialer.DialContext(probeContext, "tcp", address)
		elapsed := time.Since(started)

		cancel()

		if dialErr != nil {
			if ctx.Err() != nil {
				return 0, 0, ctx.Err()
			}

			if onSample != nil {
				onSample(index, 0, false)
			}

			continue
		}

		_ = connection.Close()
		measurements = append(measurements, elapsed)

		if onSample != nil {
			onSample(index, float64(elapsed)/float64(time.Millisecond), true)
		}
	}

	if ctx.Err() != nil {
		return 0, 0, ctx.Err()
	}

	if len(measurements) == 0 {
		return 0, 0, iperf.ErrUnreachable
	}

	median, jitter := stats(measurements)

	return float64(median) / float64(time.Millisecond), float64(jitter) / float64(time.Millisecond), nil
}

func stats(samples []time.Duration) (median, jitter time.Duration) {
	if len(samples) == 0 {
		return 0, 0
	}

	sorted := append([]time.Duration(nil), samples...)

	sort.Slice(sorted, func(left, right int) bool {
		return sorted[left] < sorted[right]
	})

	middle := len(sorted) / 2

	if len(sorted)%2 == 0 {
		median = (sorted[middle-1] + sorted[middle]) / 2
	} else {
		median = sorted[middle]
	}

	if len(samples) < 2 {
		return median, 0
	}

	var differences time.Duration

	for index := 1; index < len(samples); index++ {
		difference := samples[index] - samples[index-1]

		if difference < 0 {
			difference = -difference
		}

		differences += difference
	}

	return median, differences / time.Duration(len(samples)-1)
}
