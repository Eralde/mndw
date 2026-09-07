package telemetry

import (
	"errors"
	"testing"

	"mndwd/internal/telemetry/journal"
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
		if _, err := ParseBootID(input); err == nil {
			t.Fatalf("accepted malformed boot id %q", input)
		}
	}
}

func TestParseBootIDAcceptsCanonicalUUID(t *testing.T) {
	const canonical = "01234567-89ab-cdef-0123-456789abcdef"
	id, err := ParseBootID(canonical)
	if err != nil {
		t.Fatal(err)
	}
	if id.String() != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("boot id=%s", id.String())
	}
	if id.IsZero() {
		t.Fatal("parsed boot id reported zero")
	}
}

func TestBootClockReadFailsWhenElapsedUnavailable(t *testing.T) {
	clock := newBootClock(journal.BootID{1}, func() (int64, error) {
		return 0, errors.New("clock unavailable")
	}, func() int64 { return 1800000000000 })
	if _, err := clock.Read(); err == nil {
		t.Fatal("elapsed clock failure accepted")
	}
}

func TestBootClockElapsedNeverDecreases(t *testing.T) {
	elapsed := int64(1000)
	clock := newBootClock(journal.BootID{1}, func() (int64, error) {
		return elapsed, nil
	}, func() int64 { return 1800000000000 })

	first, err := clock.Read()
	if err != nil {
		t.Fatal(err)
	}
	if first.ElapsedMs != 1000 {
		t.Fatalf("elapsed=%d", first.ElapsedMs)
	}

	elapsed = 900
	second, err := clock.Read()
	if err != nil {
		t.Fatal(err)
	}
	if second.ElapsedMs < first.ElapsedMs {
		t.Fatalf("elapsed decreased: %d then %d", first.ElapsedMs, second.ElapsedMs)
	}
}

func TestBootClockReportsBootAndWallTime(t *testing.T) {
	boot := journal.BootID{7, 7, 7}
	clock := newBootClock(boot, func() (int64, error) { return 1500, nil }, func() int64 { return 1800000000000 })
	reading, err := clock.Read()
	if err != nil {
		t.Fatal(err)
	}
	if reading.Boot != boot {
		t.Fatalf("boot=%s", reading.Boot)
	}
	if reading.ElapsedMs != 1500 || reading.WallMs != 1800000000000 {
		t.Fatalf("reading=%+v", reading)
	}
}

func TestBootClockUnsupportedPlatform(t *testing.T) {
	clock := newUnsupportedBootClock(ErrBootClockUnsupported)
	if _, err := clock.Read(); !errors.Is(err, ErrBootClockUnsupported) {
		t.Fatalf("unsupported platform returned %v", err)
	}
}
