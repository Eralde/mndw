package enumeration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseMembersRequiresIdentityAndMACAndAllowsOfflineMembers(t *testing.T) {
	members, err := ParseMembers([]byte(`[{"cid":"node-1","mac":"AA-BB-CC-DD-EE-FF","ip":"192.168.1.2","known-host":"A","fqdn":"node-1.keenetic.io"}]`))
	if err != nil {
		t.Fatal(err)
	}

	if len(members) != 1 || members[0] != (Member{Identity: "node-1", Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff", FQDN: "node-1.keenetic.io"}) {
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

	offline, err := ParseMembers([]byte(`[{"cid":"node-2","mac":"AA-BB-CC-DD-EE-11","ip":"","fqdn":"offline.keenetic.io"}]`))
	if err != nil {
		t.Fatal(err)
	}

	if len(offline) != 1 || offline[0].Identity != "node-2" || offline[0].IP != "" || offline[0].FQDN != "offline.keenetic.io" {
		t.Fatalf("offline members = %#v", offline)
	}
}

func TestParseMembersMapsEligibilityFields(t *testing.T) {
	members, err := ParseMembers([]byte(`[{"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff","ip":"192.0.2.1","fqdn":"node-1.keenetic.io","fqdn-certificate-valid":true,"capabilities":{"auth-token":true,"security-level":{"level":"admin"}}}]`))
	if err != nil {
		t.Fatal(err)
	}

	if len(members) != 1 || !members[0].FQDNCertificateValid || !members[0].AuthTokenCapable {
		t.Fatalf("members = %#v", members)
	}
}

func TestParseMembersMapsSharedIncompleteFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "packages", "go-mws-members", "fixtures", "incomplete.json"))
	if err != nil {
		t.Fatal(err)
	}

	var value any

	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}

	data = append([]byte{'['}, append(data, ']')...)
	members, err := ParseMembers(data)
	if err != nil {
		t.Fatal(err)
	}

	if len(members) != 1 || members[0].IP != "" || members[0].FQDNCertificateValid || members[0].AuthTokenCapable {
		t.Fatalf("incomplete member = %#v", members)
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

func TestCacheRetainsLastGoodMembersAndReportsSafeStaleStatus(t *testing.T) {
	clock := time.Unix(100, 0)
	source := &fakeSource{members: []Member{{Identity: "node-1", MAC: "aa:bb:cc:dd:ee:ff"}}}
	cache := NewCache(source, 0, func() time.Time { return clock })

	if _, err := cache.List(context.Background()); err != nil {
		t.Fatal(err)
	}

	source.err = errors.New("controller token secret and URL must not escape")

	if _, err := cache.List(context.Background()); err == nil {
		t.Fatal("List() error = nil")
	}

	status := cache.Status()

	if !status.Stale || status.LastError == "" || len(status.LastGoodMembers) != 1 {
		t.Fatalf("status = %#v", status)
	}

	status.LastGoodMembers[0].Identity = "changed"

	if cache.Status().LastGoodMembers[0].Identity != "node-1" {
		t.Fatal("Status() returned mutable members")
	}
}

func TestCacheSuccessClearsStaleMetadata(t *testing.T) {
	source := &fakeSource{members: []Member{{Identity: "node-1", MAC: "aa:bb:cc:dd:ee:ff"}}}
	cache := NewCache(source, 0, time.Now)

	if _, err := cache.List(context.Background()); err != nil {
		t.Fatal(err)
	}

	source.err = errors.New("down")
	_, _ = cache.List(context.Background())
	source.err = nil

	if _, err := cache.List(context.Background()); err != nil {
		t.Fatal(err)
	}

	if status := cache.Status(); status.Stale || status.LastError != "" {
		t.Fatalf("status after success = %#v", status)
	}
}

func TestHTTPSourceUsesConfiguredControllerURL(t *testing.T) {
	transport := &enumerationRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Body: io.NopCloser(strings.NewReader(`[ {"show":{"mws":{"member":[` +
			`{"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff","ip":"192.168.1.2","fqdn":"node-1.keenetic.io"},` +
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

	if len(members) != 2 || members[0].Identity != "node-1" || members[0].FQDN != "node-1.keenetic.io" || members[1].Identity != "node-2" || members[1].IP != "" {
		t.Fatalf("members = %#v", members)
	}

	if transport.request.URL.String() != "http://192.168.1.1:80/rci/" || transport.request.Method != http.MethodPost {
		t.Fatalf("request URL = %s", transport.request.URL)
	}

	if string(transport.requestBody) != `[{"show":{"mws":{"member":{}}}}]` {
		t.Fatalf("request body = %s", transport.requestBody)
	}
}

func TestHTTPSourceEnumerateAcceptsRawMemberArray(t *testing.T) {
	transport := &enumerationRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Body: io.NopCloser(strings.NewReader(`[{
			"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff","ip":"192.168.1.2"
		},{
			"cid":"node-2","mac":"aa:bb:cc:dd:ee:11","ip":"192.168.1.3"
		}]`)),
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

	if len(members) != 2 || members[0].Identity != "node-1" || members[1].Identity != "node-2" {
		t.Fatalf("members = %#v, want two raw-array members", members)
	}

	if transport.request.URL.String() != "http://192.168.1.1:80/rci/" || transport.request.Method != http.MethodPost {
		t.Fatalf("request URL = %s, method = %s", transport.request.URL, transport.request.Method)
	}

	if got := transport.request.Header.Get("X-Ndma-Tkn"); got != "controller-token" {
		t.Fatalf("X-Ndma-Tkn = %q, want controller-token", got)
	}

	if string(transport.requestBody) != `[{"show":{"mws":{"member":{}}}}]` {
		t.Fatalf("request body = %s", transport.requestBody)
	}
}

func TestHTTPSourceReturnsCapturedControllerEpochOnUnauthorized(t *testing.T) {
	source := HTTPSource{
		Client: &http.Client{Transport: &enumerationRoundTripper{response: &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}}},
		CaptureController: func() ControllerSnapshot {
			return ControllerSnapshot{BaseURL: "http://192.0.2.1", Token: "controller", Epoch: 7}
		},
	}
	_, err := source.Enumerate(context.Background())
	var controllerError ControllerHTTPError

	if !errors.As(err, &controllerError) || controllerError.Status != http.StatusUnauthorized || controllerError.Epoch != 7 {
		t.Fatalf("error = %v, controller error = %#v", err, controllerError)
	}
}

func TestHTTPSourceDropsSuccessfulResponseFromStaleEpoch(t *testing.T) {
	transport := &enumerationRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(`[{"cid":"node-1","mac":"aa:bb:cc:dd:ee:ff"}]`)),
		Header:     make(http.Header),
	}}
	source := HTTPSource{
		Client: &http.Client{Transport: transport},
		CaptureController: func() ControllerSnapshot {
			return ControllerSnapshot{BaseURL: "http://192.0.2.1", Token: "controller", Epoch: 7}
		},
		CurrentEpoch: func() uint64 { return 8 },
	}
	_, err := source.Enumerate(context.Background())
	if !errors.Is(err, ErrStaleResult) {
		t.Fatalf("error = %v, want stale result", err)
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
