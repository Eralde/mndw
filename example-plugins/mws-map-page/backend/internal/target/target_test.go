package target

import (
	"net"
	"testing"

	"mws-map-page/internal/discovery"
)

func TestResolvePinsOnlyPrivateOrLinkLocalAddress(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		ok   bool
	}{
		{name: "private", ip: "192.168.1.8", ok: true},
		{name: "link local", ip: "169.254.1.8", ok: true},
		{name: "public", ip: "8.8.8.8", ok: false},
		{name: "loopback", ip: "127.0.0.1", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Resolve(discovery.Member{CID: "node", IP: test.ip})
			if (err == nil) != test.ok {
				t.Fatalf("Resolve(%q) error = %v", test.ip, err)
			}
		})
	}
}

func TestTargetPolicyRejectsRedirect(t *testing.T) {
	policy := ClientPolicy{NoRedirect: true}
	if err := policy.ValidateResponse(302, "http://public.example"); err == nil {
		t.Fatal("redirect accepted")
	}
	if !AllowedIP(net.ParseIP("10.0.0.1")) {
		t.Fatal("RFC1918 address rejected")
	}
}
