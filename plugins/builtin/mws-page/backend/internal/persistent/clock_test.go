package persistent

import (
	"testing"
	"time"
)

func TestNewUsesInjectedClock(t *testing.T) {
	fixed := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	client := New(Config{PluginID: "mws-page", Now: func() time.Time { return fixed }})

	if got := client.now(); !got.Equal(fixed) {
		t.Fatalf("client.now() = %v, want %v", got, fixed)
	}
}

func TestNewDefaultsClockToWallUTC(t *testing.T) {
	client := New(Config{PluginID: "mws-page"})

	got := client.now()

	if got.Location() != time.UTC {
		t.Fatalf("default clock location = %v, want UTC", got.Location())
	}

	if time.Since(got) > time.Minute {
		t.Fatalf("default clock returned stale time %v", got)
	}
}
