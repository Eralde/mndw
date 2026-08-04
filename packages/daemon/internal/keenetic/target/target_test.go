package target

import (
	"net"
	"testing"

	"mndwd/internal/keenetic/discovery"
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

func TestResolveUsesRCIPort(t *testing.T) {
	target, err := Resolve(discovery.Member{CID: "node", IP: "192.168.1.8"})
	if err != nil {
		t.Fatal(err)
	}
	if target.BaseURL != "http://192.168.1.8:79" {
		t.Fatalf("BaseURL = %q, want http://192.168.1.8:79", target.BaseURL)
	}
}

func TestTargetURLRejectsUnsafeRCIPath(t *testing.T) {
	target, err := Resolve(discovery.Member{CID: "node", IP: "192.168.1.8"})
	if err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/rci/show/version", "http://public.example/rci", "rci/../secret", "rci/show?x=1", "rci/show#fragment", "rci\\show"} {
		if _, err := target.URL(path); err == nil {
			t.Fatalf("Target.URL(%q) accepted unsafe path", path)
		}
	}
}

func TestTargetURLAcceptsRelativeRCIPath(t *testing.T) {
	target, err := Resolve(discovery.Member{CID: "node", IP: "192.168.1.8"})
	if err != nil {
		t.Fatal(err)
	}
	urlValue, err := target.URL("rci/show/version")
	if err != nil {
		t.Fatal(err)
	}
	if urlValue.String() != "http://192.168.1.8:79/rci/show/version" {
		t.Fatalf("URL = %q, want pinned RCI URL", urlValue)
	}
}
