package manifest

import (
	"slices"
	"testing"
)

func TestPersistentRCIPermissionsFollowGeneratedAuthority(t *testing.T) {
	want := []string{"persistent-rci-session:read", "persistent-rci-session:write"}

	if got := persistentRCIPermissions(); !slices.Equal(got, want) {
		t.Fatalf("persistentRCIPermissions() = %v, want %v", got, want)
	}

	if PersistentRCISessionReadPermission != want[0] || PersistentRCISessionWritePermission != want[1] {
		t.Fatalf("exported constants drifted: %q, %q", PersistentRCISessionReadPermission, PersistentRCISessionWritePermission)
	}

	for _, permission := range want {
		if !IsPersistentRCIPermission(permission) || !IsPermission(permission) {
			t.Fatalf("%q must be a persistent RCI permission", permission)
		}
	}

	if IsPersistentRCIPermission("events:wan") || IsPersistentRCIPermission("persistent-rci-session:admin") {
		t.Fatal("non-RCI permission classified as persistent RCI")
	}
}

func TestPersistentRCIPermissionsReturnsFreshSlice(t *testing.T) {
	first := persistentRCIPermissions()
	first[0] = "mutated"

	if persistentRCIPermissions()[0] != PersistentRCISessionReadPermission {
		t.Fatal("persistentRCIPermissions must not expose shared backing storage")
	}
}

func TestEventPermissionPatternFollowsGeneratedAuthority(t *testing.T) {
	for _, valid := range []string{"events:*", "events:wan", "events:wan,wifi,net"} {
		if !IsEventPermission(valid) {
			t.Fatalf("%q must be an event permission", valid)
		}
	}

	// "events:wan\n" mirrors the SDK parity case: RE2 `$` without (?m) matches only at end of text.
	for _, invalid := range []string{"events:", "events:WAN", "events:wan,", "xevents:wan", "events:wan\n", "events:wan\r\n"} {
		if IsEventPermission(invalid) {
			t.Fatalf("%q must not be an event permission", invalid)
		}
	}
}
