//go:build linux

package system

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestBootMillis(t *testing.T) {
	tests := []struct {
		name string
		ts   unix.Timespec
		want int64
	}{
		{
			name: "thirty days exceeds int32 range",
			ts:   unix.Timespec{Sec: 2_592_000, Nsec: 5_999_999},
			want: 2_592_000_005,
		},
		{
			name: "zero uptime",
			ts:   unix.Timespec{Sec: 0, Nsec: 0},
			want: 0,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := bootMillis(test.ts); got != test.want {
				t.Errorf("bootMillis(%+v) = %d, want %d", test.ts, got, test.want)
			}
		})
	}
}
