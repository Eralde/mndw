//go:build linux

package backend

import "testing"

func TestCurrentProcessIdentityHasStableExecutableMetadata(t *testing.T) {
	identity, err := ReadProcessIdentity(ownProcessID())
	if err != nil {
		t.Fatal(err)
	}

	if identity.PID <= 0 || identity.StartTimeTicks == 0 || identity.ExecutablePath == "" {
		t.Fatalf("identity = %#v", identity)
	}
}
