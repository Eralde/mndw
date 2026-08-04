package rcisession

import (
	"context"
	"errors"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
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

func TestResolveExtenderUsesFreshIdentityIPAndDefaultHTTPPort(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{Extenders: map[string]model.TokenRecord{
		"node-1": {Key: "key", Token: "token", Support: model.SupportSupported},
	}}
	enumerator := &fakeEnumerator{members: []enumeration.Member{{Identity: "node-1", IP: "192.168.1.44", MAC: "aa:bb:cc:dd:ee:ff"}}}
	service := NewService(store, enumerator)

	destination, err := service.Resolve(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if destination.BaseURL != "http://192.168.1.44" || destination.Token != "token" {
		t.Fatalf("destination = %#v", destination)
	}
}

func TestResolveControllerUsesConfiguredBaseURL(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{
		Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported},
		Extenders:  map[string]model.TokenRecord{},
	}
	service := NewService(store, &fakeEnumerator{})
	service.SetControllerURL("http://192.168.1.1:80")

	destination, err := service.Resolve(context.Background(), "controller")
	if err != nil {
		t.Fatal(err)
	}
	if destination.BaseURL != "http://192.168.1.1:80" || destination.Token != "controller-token" {
		t.Fatalf("destination = %#v", destination)
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

type fakeEnumerator struct {
	members     []enumeration.Member
	calls       int
	invalidated bool
}

func (e *fakeEnumerator) List(context.Context) ([]enumeration.Member, error) {
	e.calls++
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
