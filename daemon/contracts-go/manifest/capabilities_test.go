package manifest

import (
	"slices"
	"testing"
)

func TestPersistentRCICapabilitiesFollowGeneratedAuthority(t *testing.T) {
	want := []string{"persistent-rci-session:read", "persistent-rci-session:write"}

	if got := persistentRCICapabilities(); !slices.Equal(got, want) {
		t.Fatalf("persistentRCICapabilities() = %v, want %v", got, want)
	}

	if PersistentRCISessionReadCapability != want[0] || PersistentRCISessionWriteCapability != want[1] {
		t.Fatalf("exported constants drifted: %q, %q", PersistentRCISessionReadCapability, PersistentRCISessionWriteCapability)
	}

	for _, capability := range want {
		if !IsPersistentRCICapability(capability) || !IsCapability(capability) {
			t.Fatalf("%q must be a persistent RCI capability", capability)
		}
	}

	if IsPersistentRCICapability("events:wan") || IsPersistentRCICapability("persistent-rci-session:admin") {
		t.Fatal("non-RCI capability classified as persistent RCI")
	}
}

func TestPersistentRCICapabilitiesReturnsFreshSlice(t *testing.T) {
	first := persistentRCICapabilities()
	first[0] = "mutated"

	if persistentRCICapabilities()[0] != PersistentRCISessionReadCapability {
		t.Fatal("persistentRCICapabilities must not expose shared backing storage")
	}
}

func TestEventCapabilityPatternFollowsGeneratedAuthority(t *testing.T) {
	for _, valid := range []string{"events:*", "events:wan", "events:wan,wifi,net"} {
		if !IsEventCapability(valid) {
			t.Fatalf("%q must be an event capability", valid)
		}
	}

	// "events:wan\n" mirrors the SDK parity case: RE2 `$` without (?m) matches only at end of text.
	for _, invalid := range []string{"events:", "events:WAN", "events:wan,", "xevents:wan", "events:wan\n", "events:wan\r\n"} {
		if IsEventCapability(invalid) {
			t.Fatalf("%q must not be an event capability", invalid)
		}
	}
}
