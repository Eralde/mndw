package discovery

import (
	"encoding/json"
	"testing"
)

func TestParseMembersAndNormalizeIdentity(t *testing.T) {
	members, err := ParseMembers([]byte(`[{
		"cid":"node-1","mac":"AA-BB-CC-DD-EE-FF","ip":"192.168.1.2",
		"known-host":"A","fqdn":"router.keenetic.io"
	}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0].MAC != "aa:bb:cc:dd:ee:ff" || members[0].Identity() != "node-1" {
		t.Fatalf("members = %#v", members)
	}
	if members[0].FQDN != "router.keenetic.io" || !members[0].Online {
		t.Fatalf("member = %#v", members[0])
	}
}

func TestParseMembersPreservesOfflineFQDNAndOmitsRuntimeFields(t *testing.T) {
	members, err := ParseMembers([]byte(`[
		{"cid":"node-1","mac":"aa:bb:cc:dd:ee:01","ip":"192.168.1.2"},
		{"cid":"node-2","mac":"aa:bb:cc:dd:ee:02","ip":"","fqdn":"offline.keenetic.io"}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	members[0].LastPeer = "peer"
	data, err := json.Marshal(members[0])
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if string(data) != `{"cid":"node-1","model":"","mac":"aa:bb:cc:dd:ee:01","known-host":"","ip":"192.168.1.2","fqdn":"","fw":"","system":null,"backhaul":null}` {
		t.Fatalf("member JSON = %s", data)
	}
	if members[1].FQDN != "offline.keenetic.io" || members[1].Online {
		t.Fatalf("members = %#v", members)
	}
}

func TestParseMembersRejectsMissingAndDuplicateIdentity(t *testing.T) {
	for name, input := range map[string]string{
		"missing identity":   `[ {"mac":""} ]`,
		"duplicate identity": `[ {"cid":"same"}, {"cid":"same"} ]`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseMembers([]byte(input)); err == nil {
				t.Fatal("ParseMembers() error = nil")
			}
		})
	}
}

func TestParseUnsupportedResponse(t *testing.T) {
	if _, err := ParseMembers([]byte(`{"status":[{"status":"error","message":"MWS is not supported"}]}`)); err == nil {
		t.Fatal("ParseMembers() error = nil")
	}
}
