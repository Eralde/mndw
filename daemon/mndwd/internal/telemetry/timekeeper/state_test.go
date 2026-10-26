package timekeeper

import (
	"bytes"
	"errors"
	"testing"
)

func TestStateRoundTrip(t *testing.T) {
	state := State{
		BootID:          [16]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
		OffsetMs:        -42_500,
		Server:          "pool.ntp.org",
		SyncStartBootMs: 1_234_567,
	}

	encoded, err := EncodeState(state)
	if err != nil {
		t.Fatalf("EncodeState() error = %v", err)
	}

	got, err := DecodeState(encoded)
	if err != nil {
		t.Fatalf("DecodeState() error = %v", err)
	}

	if got != state {
		t.Fatalf("DecodeState() = %+v, want %+v", got, state)
	}
}

func TestDecodeStateRejectsCorruption(t *testing.T) {
	encoded, err := EncodeState(State{BootID: [16]byte{1}, OffsetMs: 42, Server: "ntp", SyncStartBootMs: 24})
	if err != nil {
		t.Fatalf("EncodeState() error = %v", err)
	}

	tests := []struct {
		name string
		body []byte
	}{
		{name: "crc", body: flipByte(encoded, len(encoded)-1)},
		{name: "magic", body: flipByte(encoded, 0)},
		{name: "version", body: flipByte(encoded, 8)},
		{name: "length", body: invalidServerLength(encoded)},
		{name: "truncated", body: bytes.Clone(encoded[:len(encoded)-1])},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := DecodeState(tt.body)
			if !errors.Is(err, ErrInvalidState) {
				t.Fatalf("DecodeState() error = %v, want ErrInvalidState", err)
			}
		})
	}
}

func TestEncodeStateRejectsLongServer(t *testing.T) {
	_, err := EncodeState(State{Server: string(bytes.Repeat([]byte{'x'}, 256))})
	if err == nil {
		t.Fatal("EncodeState() accepted 256-byte server")
	}
}

func flipByte(body []byte, index int) []byte {
	changed := bytes.Clone(body)
	changed[index] ^= 0xff

	return changed
}

func invalidServerLength(body []byte) []byte {
	changed := bytes.Clone(body)
	changed[42] = 0
	changed[43] = 1

	return changed
}
