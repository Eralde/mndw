package system

import (
	"encoding/hex"
	"testing"
)

func TestParseBootIDRejectsMalformed(t *testing.T) {
	malformed := []string{
		"",
		"not-a-uuid",
		"0123456789abcde",
		"0123456789abcdef0123456789abcdef0",
		"0123456789abcdef-0123-4567-89ab-cdef0123456",
		"0123456789abcdef-0123-4567-89ab-cdef01234567",
		"0123456789ABCDEF-0123-4567-89AB-CDEF012345670",
		"g123456789abcdef-0123-4567-89ab-cdef01234567",
	}

	for _, input := range malformed {
		if _, err := parseBootID(input); err == nil {
			t.Fatalf("accepted malformed boot id %q", input)
		}
	}
}

func TestParseBootIDAcceptsCanonicalUUID(t *testing.T) {
	const canonical = "01234567-89ab-cdef-0123-456789abcdef"
	id, err := parseBootID(canonical)
	if err != nil {
		t.Fatal(err)
	}

	if hex.EncodeToString(id[:]) != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("boot id=%s", hex.EncodeToString(id[:]))
	}

	if id == [16]byte{} {
		t.Fatal("parsed boot id reported zero")
	}
}
