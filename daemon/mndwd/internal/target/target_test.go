package target

import (
	"encoding/json"
	"net"
	"testing"

	"mndwd/internal/discovery"
)

func TestClassifyRCIRequest(t *testing.T) {
	telemetryBody, err := json.Marshal([]map[string]any{
		{"show": map[string]any{"system": map[string]any{}}},
		{"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"cpu": map[string]any{"detail": 0, "attribute": "avg"}}}}},
		{"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"memory": map[string]any{"detail": 0, "attribute": "used"}}}}},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name   string
		method string
		path   string
		body   []byte
		want   Access
	}{
		{name: "show path", method: "GET", path: "rci/show/system", want: AccessRead},
		{name: "whoami path", method: "GET", path: "rci/whoami", want: AccessRead},
		{name: "telemetry batch", method: "POST", path: "rci/", body: telemetryBody, want: AccessRead},
		{name: "set body", method: "POST", path: "rci/", body: []byte(`[{"interface":{"name":"WifiMaster0","power":75}}]`), want: AccessWrite},
		{name: "mixed batch", method: "POST", path: "rci/", body: []byte(`[{"show":{"system":{}}},{"interface":{"name":"WifiMaster0","power":75}}]`), want: AccessWrite},
		{name: "malformed", method: "POST", path: "rci/", body: []byte("{"), want: AccessWrite},
		{name: "other method", method: "PUT", path: "rci/show/system", want: AccessWrite},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Classify(test.method, test.path, test.body); got != test.want {
				t.Fatalf("Classify() = %v, want %v", got, test.want)
			}
		})
	}
}

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

func TestResolveUsesDefaultHTTPPortForRemoteMember(t *testing.T) {
	target, err := Resolve(discovery.Member{CID: "node", IP: "192.168.1.8"})
	if err != nil {
		t.Fatal(err)
	}

	if target.BaseURL != "http://192.168.1.8" {
		t.Fatalf("BaseURL = %q, want http://192.168.1.8", target.BaseURL)
	}
}

func TestResolvePrefersNormalizedFQDNAndDoesNotRequireIP(t *testing.T) {
	target, err := Resolve(discovery.Member{
		CID:  "node",
		IP:   "",
		FQDN: "NODE-1.Keenetic.io...",
	})
	if err != nil {
		t.Fatal(err)
	}

	if target.FQDN != "node-1.keenetic.io" || target.BaseURL != "https://node-1.keenetic.io" || !target.Secure || target.Address != nil {
		t.Fatalf("target = %#v", target)
	}
}

func TestResolveFQDNWinsOverIP(t *testing.T) {
	target, err := Resolve(discovery.Member{CID: "node", IP: "192.168.1.8", FQDN: "node-1.keenetic.io"})
	if err != nil {
		t.Fatal(err)
	}

	if target.BaseURL != "https://node-1.keenetic.io" || !target.Secure {
		t.Fatalf("target = %#v", target)
	}
}

func TestResolveRejectsMalformedFQDNWithoutIPFallback(t *testing.T) {
	for _, fqdn := range []string{
		"",
		"node",
		"node_.keenetic.io",
		"node.keenetic.io/path",
		"http://node.keenetic.io",
		"node:443.keenetic.io",
		"node..keenetic.io",
		"-node.keenetic.io",
		"node-.keenetic.io",
		"127.0.0.1",
		"nöde.keenetic.io",
	} {
		if fqdn == "" {
			continue
		}

		_, err := Resolve(discovery.Member{CID: "node", IP: "192.168.1.8", FQDN: fqdn})
		if err == nil {
			t.Fatalf("Resolve(%q) succeeded", fqdn)
		}
	}
}

func TestResolveRejectsMissingOrUnsafeIPWithoutFQDN(t *testing.T) {
	for _, ip := range []string{"", "not-an-ip", "8.8.8.8", "127.0.0.1"} {
		if _, err := Resolve(discovery.Member{CID: "node", IP: ip}); err == nil {
			t.Fatalf("Resolve(%q) succeeded", ip)
		}
	}
}

func TestTargetURLAcceptsSecureFQDNWithoutAddress(t *testing.T) {
	target, err := Resolve(discovery.Member{CID: "node", FQDN: "node-1.keenetic.io"})
	if err != nil {
		t.Fatal(err)
	}

	urlValue, err := target.URL("rci/show/version")
	if err != nil {
		t.Fatal(err)
	}

	if urlValue.String() != "https://node-1.keenetic.io/rci/show/version" {
		t.Fatalf("URL = %q", urlValue)
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

	if urlValue.String() != "http://192.168.1.8/rci/show/version" {
		t.Fatalf("URL = %q, want pinned RCI URL", urlValue)
	}
}
