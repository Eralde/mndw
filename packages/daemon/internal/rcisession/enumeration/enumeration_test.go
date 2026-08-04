package enumeration

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestParseMembersRequiresIdentityAndMACAndAllowsOfflineMembers(t *testing.T) {
	members, err := ParseMembers([]byte(`[{"cid":"node-1","mac":"AA-BB-CC-DD-EE-FF","ip":"192.168.1.2","known-host":"A"}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0] != (Member{Identity: "node-1", Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}) {
		t.Fatalf("members = %#v", members)
	}

	for _, input := range []string{
		`[{"cid":"node-1","mac":"","ip":"192.168.1.2"}]`,
		`[{"cid":"","mac":"","ip":"192.168.1.2"}]`,
		`[{"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff","ip":"not-an-ip"}]`,
	} {
		if _, err := ParseMembers([]byte(input)); err == nil {
			t.Fatalf("ParseMembers(%s) succeeded, want validation error", input)
		}
	}

	offline, err := ParseMembers([]byte(`[{"cid":"node-2","mac":"AA-BB-CC-DD-EE-11","ip":""}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(offline) != 1 || offline[0].Identity != "node-2" || offline[0].IP != "" {
		t.Fatalf("offline members = %#v", offline)
	}
}

func TestParseMembersRejectsDuplicateIdentity(t *testing.T) {
	data := []byte(`[{"cid":"node-1","mac":"aa:bb:cc:dd:ee:01","ip":"192.168.1.2"},{"cid":"node-1","mac":"aa:bb:cc:dd:ee:02","ip":"192.168.1.3"}]`)
	if _, err := ParseMembers(data); err == nil {
		t.Fatal("ParseMembers accepted duplicate identity")
	}
}

func TestCacheUsesFreshMembersAndFailsClosedWhenStale(t *testing.T) {
	clock := time.Unix(100, 0)
	source := &fakeSource{members: []Member{{Identity: "node-1", Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}}}
	cache := NewCache(source, 30*time.Second, func() time.Time { return clock })

	first, err := cache.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first[0].IP = "192.168.1.99"
	clock = clock.Add(29 * time.Second)
	second, err := cache.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second[0].IP != "192.168.1.2" || source.calls != 1 {
		t.Fatalf("fresh cache result = %#v, calls = %d", second, source.calls)
	}

	clock = clock.Add(1 * time.Second)
	source.err = errors.New("controller down")
	if _, err := cache.List(context.Background()); !errors.Is(err, ErrTargetUnreachable) {
		t.Fatalf("stale cache error = %v, want ErrTargetUnreachable", err)
	}
}

func TestCacheInvalidationForcesEnumeration(t *testing.T) {
	clock := time.Unix(100, 0)
	source := &fakeSource{members: []Member{{Identity: "node-1", Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}}}
	cache := NewCache(source, time.Minute, func() time.Time { return clock })
	if _, err := cache.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	cache.Invalidate()
	source.members[0].IP = "192.168.1.3"
	members, err := cache.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if members[0].IP != "192.168.1.3" || source.calls != 2 {
		t.Fatalf("members = %#v, calls = %d", members, source.calls)
	}
}

func TestHTTPSourceUsesConfiguredControllerURL(t *testing.T) {
	transport := &enumerationRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Body: io.NopCloser(strings.NewReader(`[ {"show":{"mws":{"member":[` +
			`{"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff","ip":"192.168.1.2"},` +
			`{"cid":"node-2","mac":"aa:bb:cc:dd:ee:11","ip":""}` +
			`]}}} ]`)),
		Header: make(http.Header),
	}}
	source := HTTPSource{
		Client:          &http.Client{Transport: transport},
		ControllerURL:   "http://192.168.1.1:80",
		ControllerToken: func() string { return "controller-token" },
	}

	members, err := source.Enumerate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 2 || members[0].Identity != "node-1" || members[1].Identity != "node-2" || members[1].IP != "" {
		t.Fatalf("members = %#v", members)
	}
	if transport.request.URL.String() != "http://192.168.1.1:80/rci/" || transport.request.Method != http.MethodPost {
		t.Fatalf("request URL = %s", transport.request.URL)
	}
	if string(transport.requestBody) != `[{"show":{"mws":{"member":{}}}}]` {
		t.Fatalf("request body = %s", transport.requestBody)
	}
}

type fakeSource struct {
	members []Member
	err     error
	calls   int
}

func (f *fakeSource) Enumerate(context.Context) ([]Member, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return append([]Member(nil), f.members...), nil
}

type enumerationRoundTripper struct {
	request     *http.Request
	requestBody []byte
	response    *http.Response
}

func (r *enumerationRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	r.request = request
	r.requestBody, _ = io.ReadAll(request.Body)

	return r.response, nil
}

func TestParseMemberResponseAcceptsRawAndRciEnvelopedPayloads(t *testing.T) {
	raw := []byte(`[{"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff","ip":"192.168.1.2"}]`)
	enveloped := []byte(`[ {"show":{"mws":{"member":` + string(raw) + `}}} ]`)

	for _, data := range [][]byte{raw, enveloped} {
		members, err := parseMemberResponse(data)
		if err != nil || len(members) != 1 || members[0].Identity != "node-1" {
			t.Fatalf("parseMemberResponse(%s) = %#v, %v", data, members, err)
		}
	}
}
