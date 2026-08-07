package main_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"mndw.local/device-auth"
	"mws-page/internal/discovery"
	"mws-page/internal/target"
	"mws-page/internal/testsupport"
)

func TestHTTPAuthGenerations(t *testing.T) {
	for _, test := range []struct {
		name       string
		generation testsupport.AuthGeneration
		random     func([]byte) error
	}{
		{name: "legacy", generation: testsupport.LegacyAuth},
		{name: "scram", generation: testsupport.ScramAuth, random: deterministicRandom},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := testsupport.NewFakeExtender(t, test.generation, "admin", "secret")
			adapter := auth.New(auth.Options{Transport: auth.NewHTTPTransport(nil), Random: test.random, Argon2Memory: 8, Argon2Iter: 2})
			result, err := adapter.Authenticate(context.Background(), auth.Target{BaseURL: fake.Server.URL}, auth.Credentials{Username: "admin", Password: "secret"}, nil)
			if err != nil {
				t.Fatalf("Authenticate() error = %v", err)
			}
			if result.Generation == "" || result.Jar == nil {
				t.Fatalf("result = %#v, want authenticated session", result)
			}
			cookies := result.Jar.Cookies(parseURL(t, fake.Server.URL))
			if len(cookies) == 0 {
				t.Fatal("authenticated session did not retain extender cookie")
			}
			fake.Expire()
			if _, err := adapter.Authenticate(context.Background(), auth.Target{BaseURL: fake.Server.URL}, auth.Credentials{Username: "admin", Password: "secret"}, result.Jar); err != nil {
				t.Fatalf("reauthentication after expiry error = %v", err)
			}
		})
	}
}

func TestFakeControllerDiscoveryFlowAndTargetPolicy(t *testing.T) {
	members := []map[string]any{{
		"cid":        "node-1",
		"model":      "mws-extender",
		"mac":        "AA-BB-CC-DD-EE-FF",
		"known-host": "kitchen",
		"ip":         "192.168.1.42",
	}}
	payload, err := json.Marshal(members)
	if err != nil {
		t.Fatal(err)
	}
	fake := testsupport.NewFakeController(t, "admin", "secret", payload)
	adapter := auth.New(auth.Options{Transport: auth.NewHTTPTransport(nil)})
	result, err := adapter.Authenticate(context.Background(), auth.Target{BaseURL: fake.Server.URL}, auth.Credentials{Username: "admin", Password: "secret"}, nil)
	if err != nil {
		t.Fatalf("controller Authenticate() error = %v", err)
	}

	request, err := json.Marshal([]map[string]any{{"show": map[string]any{"mws": map[string]any{"member": map[string]any{}}}}})
	if err != nil {
		t.Fatal(err)
	}
	transport := auth.NewHTTPTransport(nil)
	reply, err := transport.Do(context.Background(), auth.Target{BaseURL: fake.Server.URL}, result.Jar, http.MethodPost, "/rci/", request)
	if err != nil {
		t.Fatalf("controller query error = %v", err)
	}
	parsed, err := discovery.ParseMembers(extractMemberPayload(reply.Body))
	if err != nil {
		t.Fatalf("ParseMembers() error = %v", err)
	}
	if len(parsed) != 1 || parsed[0].Identity() != "node-1" || parsed[0].MAC != "aa:bb:cc:dd:ee:ff" {
		t.Fatalf("members = %#v", parsed)
	}
	if _, err := target.Resolve(parsed[0]); err != nil {
		t.Fatalf("target.Resolve() error = %v", err)
	}
	parsed[0].IP = "8.8.8.8"
	if _, err := target.Resolve(parsed[0]); err == nil {
		t.Fatal("target.Resolve() accepted public address")
	}

	fake.SetMembers([]byte(`[{"cid":"node-1","ip":"192.168.1.43"}]`))
	reply, err = transport.Do(context.Background(), auth.Target{BaseURL: fake.Server.URL}, result.Jar, http.MethodPost, "/rci/", request)
	if err != nil {
		t.Fatalf("updated controller query error = %v", err)
	}
	updated, err := discovery.ParseMembers(extractMemberPayload(reply.Body))
	if err != nil {
		t.Fatalf("updated ParseMembers() error = %v", err)
	}
	if len(updated) != 1 || updated[0].IP != "192.168.1.43" {
		t.Fatalf("updated members = %#v", updated)
	}
}

func extractMemberPayload(data []byte) []byte {
	var envelope []struct {
		Show struct {
			MWS struct {
				Member json.RawMessage `json:"member"`
			} `json:"mws"`
		} `json:"show"`
	}
	if json.Unmarshal(data, &envelope) != nil || len(envelope) == 0 {
		return nil
	}
	return envelope[0].Show.MWS.Member
}

func deterministicRandom(buffer []byte) error {
	for index := range buffer {
		buffer[index] = byte(index)
	}
	return nil
}

func parseURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
