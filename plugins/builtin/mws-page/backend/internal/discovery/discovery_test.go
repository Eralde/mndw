package discovery

import (
	"testing"
)

func TestParseMembersAndNormalizeIdentity(t *testing.T) {
	members, err := ParseMembers([]byte(`[{"cid":"node-1","mac":"AA-BB-CC-DD-EE-FF","ip":"192.168.1.2","known-host":"A","fqdn":"node.keenetic.io"}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0].MAC != "aa:bb:cc:dd:ee:ff" || members[0].Identity() != "node-1" {
		t.Fatalf("members = %#v", members)
	}
	if members[0].FQDN != "node.keenetic.io" {
		t.Fatalf("FQDN = %q", members[0].FQDN)
	}
}

func TestParseUnsupportedResponse(t *testing.T) {
	if _, err := ParseMembers([]byte(`{"status":[{"status":"error","message":"MWS is not supported"}]}`)); err == nil {
		t.Fatal("ParseMembers() error = nil")
	}
}
