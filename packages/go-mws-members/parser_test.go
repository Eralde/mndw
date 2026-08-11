package mwsmembers

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseMembersPreservesFQDNAndRuntimeState(t *testing.T) {
	members, err := ParseMembers([]byte(`[{
		"cid":"node-1",
		"mac":" AA-BB-CC-DD-EE-FF ",
		"known-host":"router",
		"ip":"192.0.2.1",
		"fqdn":"node-1.keenetic.io"
	}]`))
	if err != nil {
		t.Fatal(err)
	}

	if len(members) != 1 {
		t.Fatalf("members = %#v, want one member", members)
	}

	member := members[0]

	if member.FQDN != "node-1.keenetic.io" {
		t.Fatalf("FQDN = %q", member.FQDN)
	}

	if member.MAC != "aa:bb:cc:dd:ee:ff" {
		t.Fatalf("MAC = %q", member.MAC)
	}

	if member.Identity() != "node-1" {
		t.Fatalf("Identity() = %q", member.Identity())
	}

	if !member.Online {
		t.Fatal("Online = false, want true")
	}

	encoded, err := json.Marshal(member)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(encoded), "online") || strings.Contains(string(encoded), "lastPeer") {
		t.Fatalf("runtime fields serialized: %s", encoded)
	}
}

func TestParseMembersAllowsMissingFQDNAndUsesMACIdentity(t *testing.T) {
	members, err := ParseMembers([]byte(`[{"mac":"11.22.33.44.55.66","ip":""}]`))
	if err != nil {
		t.Fatal(err)
	}

	if got, want := members[0].Identity(), "11:22:33:44:55:66"; got != want {
		t.Fatalf("Identity() = %q, want %q", got, want)
	}

	if members[0].Online {
		t.Fatal("Online = true, want false")
	}

	if members[0].FQDN != "" {
		t.Fatalf("FQDN = %q, want empty", members[0].FQDN)
	}
}

func TestNormalizeMAC(t *testing.T) {
	tests := map[string]string{
		" AA-BB-CC-DD-EE-FF ": "aa:bb:cc:dd:ee:ff",
		"11.22.33.44.55.66":   "11:22:33:44:55:66",
		"AA:BB:CC:DD:EE:FF":   "aa:bb:cc:dd:ee:ff",
	}

	for input, want := range tests {
		if got := NormalizeMAC(input); got != want {
			t.Errorf("NormalizeMAC(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseMembersRejectsInvalidIdentity(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{name: "missing identity", data: `[{"model":"router"}]`, want: "controller member has no identity"},
		{name: "duplicate CID", data: `[{"cid":"node-1"},{"cid":"node-1"}]`, want: "controller member identity is ambiguous"},
		{name: "duplicate MAC", data: `[{"mac":"aa-bb-cc-dd-ee-ff"},{"mac":"AA:BB:CC:DD:EE:FF"}]`, want: "controller member identity is ambiguous"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseMembers([]byte(test.data))
			if err == nil || err.Error() != test.want {
				t.Fatalf("ParseMembers() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestParseMembersRejectsUnsupportedAndMalformedResponses(t *testing.T) {
	if _, err := ParseMembers([]byte(`{"status":[{"status":"error","message":"not supported"}]}`)); err == nil || err.Error() != "controller discovery unsupported: not supported" {
		t.Fatalf("unsupported response error = %v", err)
	}

	if _, err := ParseMembers([]byte(`{"broken"`)); err == nil || err.Error() != "invalid controller member response" {
		t.Fatalf("malformed response error = %v", err)
	}
}
