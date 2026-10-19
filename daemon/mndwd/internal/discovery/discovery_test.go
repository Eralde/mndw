package discovery

import (
	"testing"
)

func TestParseMembersAndNormalizeIdentity(t *testing.T) {
	members, err := ParseMembers([]byte(`[{"cid":"node-1","mac":"AA-BB-CC-DD-EE-FF","ip":"192.168.1.2","known-host":"A","fqdn":"76be7d62822bff3c2f7c8bc6.keenetic.io"}]`))
	if err != nil {
		t.Fatal(err)
	}

	if len(members) != 1 || members[0].MAC != "aa:bb:cc:dd:ee:ff" || members[0].Identity() != "node-1" {
		t.Fatalf("members = %#v", members)
	}

	if members[0].FQDN != "76be7d62822bff3c2f7c8bc6.keenetic.io" {
		t.Fatalf("FQDN = %q", members[0].FQDN)
	}
}

func TestParseMembersPreservesMissingFQDNAndOfflineFQDNMember(t *testing.T) {
	members, err := ParseMembers([]byte(`[
		{"cid":"node-1","mac":"aa:bb:cc:dd:ee:01","ip":"192.168.1.2"},
		{"cid":"node-2","mac":"aa:bb:cc:dd:ee:02","ip":"","fqdn":"offline.keenetic.io"}
	]`))
	if err != nil {
		t.Fatal(err)
	}

	if len(members) != 2 || members[0].FQDN != "" || members[1].FQDN != "offline.keenetic.io" || members[1].Online {
		t.Fatalf("members = %#v", members)
	}
}

func TestParseUnsupportedResponse(t *testing.T) {
	if _, err := ParseMembers([]byte(`{"status":[{"status":"error","message":"MWS is not supported"}]}`)); err == nil {
		t.Fatal("ParseMembers() error = nil")
	}
}
