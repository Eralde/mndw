package rcisession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
)

func TestControllerUnauthorizedRetainsControllerAndExtenderRecords(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{
		Controller: &model.TokenRecord{Key: "controller", Token: "controller-token", Support: model.SupportSupported},
		Extenders:  map[string]model.TokenRecord{"node-1": {Key: "ext-key", Token: "ext-token", Support: model.SupportSupported}},
	}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}}}
	service := NewService(store, enumerator)

	service.Unauthorized("controller")
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if document.Controller == nil || document.Controller.Token != "controller-token" || document.Controller.Support != model.SupportInvalid {
		t.Fatalf("controller = %#v", document.Controller)
	}
	if document.Extenders["node-1"].Token != "ext-token" {
		t.Fatalf("extender = %#v", document.Extenders["node-1"])
	}
	if !enumerator.invalidated {
		t.Fatal("controller 401 did not invalidate enumeration")
	}
}

func TestExtenderUnauthorizedDropsOnlyThatToken(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{
		Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported},
		Extenders: map[string]model.TokenRecord{
			"node-1": {Key: "key-1", Token: "token-1", Support: model.SupportSupported},
			"node-2": {Key: "key-2", Token: "token-2", Support: model.SupportSupported},
		},
	}
	service := NewService(store, &fakeEnumerator{})

	service.Unauthorized("node-1")
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if document.Extenders["node-1"].Token != "" || document.Extenders["node-1"].Key != "" || document.Extenders["node-1"].Support != model.SupportUnknown {
		t.Fatalf("invalid extender = %#v", document.Extenders["node-1"])
	}
	if document.Extenders["node-2"].Token != "token-2" || document.Controller.Token != "controller-token" {
		t.Fatalf("unrelated records changed: %#v", document)
	}
}

func TestExtenderUnauthorizedLogsSafePersistentSessionEvent(t *testing.T) {
	store := newFakeStore()
	store.document.Extenders = map[string]model.TokenRecord{
		"node-1": {Key: "token-id", Token: "DO_NOT_LOG", Support: model.SupportSupported},
	}
	var logs bytes.Buffer
	service := NewService(store, &fakeEnumerator{})
	service.SetLogger(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))

	service.Unauthorized("node-1")

	output := logs.String()
	if !strings.Contains(output, "persistent RCI token invalidated") || !strings.Contains(output, "identity=node-1") {
		t.Fatalf("mutation log = %s", output)
	}
	if strings.Contains(output, "DO_NOT_LOG") || strings.Contains(output, "token-id") {
		t.Fatalf("mutation log leaked token material: %s", output)
	}
}

func TestResolveExtenderUsesFreshIdentityIPAndDefaultHTTPPort(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{Extenders: map[string]model.TokenRecord{
		"node-1": {Key: "key", Token: "token", Support: model.SupportSupported},
	}}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", IP: "192.168.1.44", MAC: "aa:bb:cc:dd:ee:ff"}}}
	service := NewService(store, enumerator)

	_, err := service.Resolve(context.Background(), "node-1")
	if !errors.Is(err, proxy.ErrSecureEndpointUnavailable) {
		t.Fatalf("Resolve error = %v, want secure endpoint unavailable", err)
	}
}

func TestResolveExtenderUsesFreshFQDNForStoredToken(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{Extenders: map[string]model.TokenRecord{
		"node-1": {Key: "key", Token: "token", Support: model.SupportSupported},
	}}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", IP: "", FQDN: "node-1.keenetic.io", MAC: "aa:bb:cc:dd:ee:ff"}}}
	service := NewService(store, enumerator)

	destination, err := service.Resolve(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if destination.BaseURL != "https://node-1.keenetic.io" || destination.Token != "token" || destination.AllowInsecure {
		t.Fatalf("destination = %#v", destination)
	}
}

func TestResolveExtenderFailsClosedWhenFQDNDisappears(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{Extenders: map[string]model.TokenRecord{
		"node-1": {Key: "key", Token: "token", Support: model.SupportSupported},
	}}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", IP: "192.168.1.44", MAC: "aa:bb:cc:dd:ee:ff"}}}
	service := NewService(store, enumerator)

	_, err := service.Resolve(context.Background(), "node-1")
	if !errors.Is(err, proxy.ErrSecureEndpointUnavailable) {
		t.Fatalf("Resolve error = %v, want secure endpoint unavailable", err)
	}
}

func TestResolveControllerUsesConfiguredBaseURL(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{
		Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported},
		Extenders:  map[string]model.TokenRecord{},
	}
	service := NewService(store, &fakeEnumerator{})
	if err := service.SetControllerURL("http://192.168.1.1:80", true); err != nil {
		t.Fatal(err)
	}

	destination, err := service.Resolve(context.Background(), "controller")
	if err != nil {
		t.Fatal(err)
	}
	if destination.BaseURL != "http://192.168.1.1:80" || destination.Token != "controller-token" || !destination.AllowInsecure {
		t.Fatalf("destination = %#v", destination)
	}
}

func TestSetControllerURLRejectsRemoteHTTPOutsideDev(t *testing.T) {
	service := NewService(newFakeStore(), &fakeEnumerator{})
	if err := service.SetControllerURL("http://192.168.1.1:80", false); err == nil {
		t.Fatal("remote HTTP controller URL accepted outside dev")
	}
	if err := service.SetControllerURL("http://127.0.0.1:79", false); err != nil {
		t.Fatal(err)
	}
}

func TestSetControllerURLRejectsMalformedURLWithoutChangingState(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported}}
	service := NewService(store, &fakeEnumerator{})
	if err := service.SetControllerURL("http://192.168.1.1:80", true); err != nil {
		t.Fatal(err)
	}
	if err := service.SetControllerURL("http://user:password@192.168.1.2", true); err == nil {
		t.Fatal("malformed controller URL accepted")
	}
	destination, err := service.Resolve(context.Background(), "controller")
	if err != nil {
		t.Fatal(err)
	}
	if destination.BaseURL != "http://192.168.1.1:80" {
		t.Fatalf("controller URL changed after rejected update: %q", destination.BaseURL)
	}
}

func TestResolveFailsClosedWhenControllerIsInvalid(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{
		Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportInvalid},
		Extenders:  map[string]model.TokenRecord{"node-1": {Token: "token", Support: model.SupportSupported}},
	}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}}}
	service := NewService(store, enumerator)

	if _, err := service.Resolve(context.Background(), "node-1"); !errors.Is(err, ErrControllerInvalid) {
		t.Fatalf("Resolve error = %v, want controller invalid", err)
	}
	if enumerator.calls != 0 {
		t.Fatalf("invalid controller triggered enumeration: %d calls", enumerator.calls)
	}
}

func TestSaveControllerRevalidatesAndDoesNotPersistFailedToken(t *testing.T) {
	store := newFakeStore()
	service := NewService(store, &fakeEnumerator{})
	tester := fakeControllerTester{verdict: ControllerInvalidToken}

	verdict, err := service.SaveController(context.Background(), &tester, "bad-token")
	if err != nil || verdict != ControllerInvalidToken {
		t.Fatalf("SaveController() = %q, %v", verdict, err)
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if document.Controller != nil {
		t.Fatalf("failed controller persisted: %#v", document.Controller)
	}
	if tester.calls != 1 {
		t.Fatalf("tester calls = %d, want 1", tester.calls)
	}
}

func TestSaveControllerStoresOnlyValidatedToken(t *testing.T) {
	store := newFakeStore()
	service := NewService(store, &fakeEnumerator{})
	tester := fakeControllerTester{verdict: ControllerValid}

	verdict, err := service.SaveController(context.Background(), &tester, "valid-token")
	if err != nil || verdict != ControllerValid {
		t.Fatalf("SaveController() = %q, %v", verdict, err)
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if document.Controller == nil || document.Controller.Token != "valid-token" || document.Controller.Support != model.SupportSupported {
		t.Fatalf("controller = %#v", document.Controller)
	}
}

func TestDeleteExtendersRevokesRemoteTokensByID(t *testing.T) {
	store := newFakeStore()
	store.document.Extenders = map[string]model.TokenRecord{
		"node-1": {Key: "token-id-1", Token: "token-value-1", Support: model.SupportSupported},
	}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", FQDN: "node-1.keenetic.io", MAC: "aa:bb:cc:dd:ee:ff"}}}
	client := &recordingHTTPClient{}
	service := NewService(store, enumerator)
	service.Proxy(&http.Client{Transport: recordingRoundTripper{client: client}}, 1<<20, 0)

	if err := service.DeleteExtenders(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(client.requests))
	}
	request := client.requests[0]
	if request.Method != http.MethodPost || request.URL.String() != "https://node-1.keenetic.io/rci/" {
		t.Fatalf("request = %s %s", request.Method, request.URL)
	}
	if request.Header.Get("X-Ndma-Tkn") != "token-value-1" {
		t.Fatalf("authentication token = %q", request.Header.Get("X-Ndma-Tkn"))
	}
	var body struct {
		Authentication struct {
			Token struct {
				Delete struct {
					ID string `json:"id"`
				} `json:"delete"`
			} `json:"token"`
		} `json:"authentication"`
	}
	if err := json.Unmarshal(client.bodies[0], &body); err != nil {
		t.Fatal(err)
	}
	if body.Authentication.Token.Delete.ID != "token-id-1" {
		t.Fatalf("delete token ID = %q", body.Authentication.Token.Delete.ID)
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Extenders) != 0 {
		t.Fatalf("extenders after clear = %#v", document.Extenders)
	}
}

func TestDeleteExtendersRemovesMembersMissingFromFreshEnumeration(t *testing.T) {
	store := newFakeStore()
	store.document.Extenders = map[string]model.TokenRecord{
		"node-deleted": {Key: "token-id-deleted", Token: "token-value-deleted", Support: model.SupportSupported},
	}
	enumerator := &fakeEnumerator{}
	client := &recordingHTTPClient{}
	service := NewService(store, enumerator)
	service.Proxy(&http.Client{Transport: recordingRoundTripper{client: client}}, 1<<20, 0)

	if err := service.DeleteExtenders(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !enumerator.invalidated || enumerator.calls != 1 {
		t.Fatalf("enumeration invalidated=%v calls=%d, want invalidated once", enumerator.invalidated, enumerator.calls)
	}
	if len(client.requests) != 0 {
		t.Fatalf("remote revoke requests = %d, want 0", len(client.requests))
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Extenders) != 0 {
		t.Fatalf("extenders after clear = %#v", document.Extenders)
	}
}

func TestDeleteExtendersRetainsRecordsWhenFreshEnumerationFails(t *testing.T) {
	store := newFakeStore()
	store.document.Extenders = map[string]model.TokenRecord{
		"node-1": {Key: "token-id-1", Token: "token-value-1", Support: model.SupportSupported},
	}
	enumerator := &fakeEnumerator{err: errors.New("controller unavailable")}
	client := &recordingHTTPClient{}
	service := NewService(store, enumerator)
	service.Proxy(&http.Client{Transport: recordingRoundTripper{client: client}}, 1<<20, 0)

	if err := service.DeleteExtenders(context.Background()); !errors.Is(err, ErrExtenderTokenDeletion) {
		t.Fatalf("DeleteExtenders error = %v, want extender token deletion error", err)
	}
	if !enumerator.invalidated || enumerator.calls != 1 {
		t.Fatalf("enumeration invalidated=%v calls=%d, want invalidated once", enumerator.invalidated, enumerator.calls)
	}
	if len(client.requests) != 0 {
		t.Fatalf("remote revoke requests = %d, want 0", len(client.requests))
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := document.Extenders["node-1"]; !ok {
		t.Fatal("extender record was removed after enumeration failure")
	}
}

func TestDeleteExtendersRetainsFailedRevocations(t *testing.T) {
	store := newFakeStore()
	store.document.Extenders = map[string]model.TokenRecord{
		"node-fail": {Key: "token-id-fail", Token: "token-value-fail", Support: model.SupportSupported},
		"node-ok":   {Key: "token-id-ok", Token: "token-value-ok", Support: model.SupportSupported},
	}
	enumerator := &fakeEnumerator{members: []enumeration.Member{
		{Identity: "node-fail", FQDN: "node-fail.keenetic.io", MAC: "aa:bb:cc:dd:ee:01"},
		{Identity: "node-ok", FQDN: "node-ok.keenetic.io", MAC: "aa:bb:cc:dd:ee:02"},
	}}
	client := &recordingHTTPClient{statusByHost: map[string]int{"node-fail.keenetic.io": http.StatusBadGateway}}
	service := NewService(store, enumerator)
	service.Proxy(&http.Client{Transport: recordingRoundTripper{client: client}}, 1<<20, 0)

	if err := service.DeleteExtenders(context.Background()); err == nil {
		t.Fatal("DeleteExtenders succeeded after remote revocation failure")
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := document.Extenders["node-fail"]; !ok {
		t.Fatal("failed remote token was removed locally")
	}
	if _, ok := document.Extenders["node-ok"]; ok {
		t.Fatal("successfully revoked token was retained locally")
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(client.requests))
	}
}

func TestDeleteExtendersRemovesAlreadyInvalidToken(t *testing.T) {
	store := newFakeStore()
	store.document.Extenders = map[string]model.TokenRecord{
		"node-1": {Key: "token-id-1", Token: "token-value-1", Support: model.SupportSupported},
	}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", FQDN: "node-1.keenetic.io", MAC: "aa:bb:cc:dd:ee:ff"}}}
	client := &recordingHTTPClient{statusByHost: map[string]int{"node-1.keenetic.io": http.StatusUnauthorized}}
	service := NewService(store, enumerator)
	service.Proxy(&http.Client{Transport: recordingRoundTripper{client: client}}, 1<<20, 0)

	if err := service.DeleteExtenders(context.Background()); err != nil {
		t.Fatal(err)
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Extenders) != 0 {
		t.Fatalf("already invalid extender = %#v", document.Extenders)
	}
}

type fakeStore struct {
	document model.Document
}

func newFakeStore() *fakeStore {
	return &fakeStore{document: model.Document{Extenders: make(map[string]model.TokenRecord)}}
}

func (s *fakeStore) State() model.StoreState { return model.StateOK }

func (s *fakeStore) Snapshot() (model.Document, error) {
	document := model.Document{Extenders: make(map[string]model.TokenRecord)}
	if s.document.Controller != nil {
		record := *s.document.Controller
		document.Controller = &record
	}
	for identity, record := range s.document.Extenders {
		document.Extenders[identity] = record
	}
	return document, nil
}

func (s *fakeStore) ReplaceController(record model.TokenRecord) error {
	s.document.Controller = &record
	return nil
}

func (s *fakeStore) DeleteController() error {
	s.document.Controller = nil
	s.document.Extenders = make(map[string]model.TokenRecord)
	return nil
}

func (s *fakeStore) UpsertExtender(identity string, record model.TokenRecord) error {
	if s.document.Extenders == nil {
		s.document.Extenders = make(map[string]model.TokenRecord)
	}
	s.document.Extenders[identity] = record
	return nil
}

func (s *fakeStore) DeleteExtender(identity string) error {
	delete(s.document.Extenders, identity)
	return nil
}

func (s *fakeStore) DeleteExtenders() error {
	s.document.Extenders = make(map[string]model.TokenRecord)
	return nil
}

type recordingHTTPClient struct {
	requests     []*http.Request
	bodies       [][]byte
	statusByHost map[string]int
}

type recordingRoundTripper struct {
	client *recordingHTTPClient
}

func (t recordingRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return t.client.Do(request)
}

func (c *recordingHTTPClient) Do(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	c.requests = append(c.requests, request)
	c.bodies = append(c.bodies, body)
	status := c.statusByHost[request.URL.Host]
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(`{}`)),
		Header:     make(http.Header),
		Request:    request,
	}, nil
}

type fakeEnumerator struct {
	members     []enumeration.Member
	err         error
	calls       int
	invalidated bool
}

func (e *fakeEnumerator) List(context.Context) ([]enumeration.Member, error) {
	e.calls++
	if e.err != nil {
		return nil, e.err
	}
	return append([]enumeration.Member(nil), e.members...), nil
}

func (e *fakeEnumerator) Invalidate() { e.invalidated = true }

type fakeControllerTester struct {
	verdict ControllerVerdict
	calls   int
}

func (f *fakeControllerTester) Test(context.Context, string) (ControllerVerdict, error) {
	f.calls++
	return f.verdict, nil
}
