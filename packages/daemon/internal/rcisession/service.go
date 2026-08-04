package rcisession

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"mndwd/internal/keenetic/discovery"
	"mndwd/internal/keenetic/target"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/minter"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/rcisession/socket"
)

var ErrControllerInvalid = errors.New("controller session invalid")

type Store interface {
	State() model.StoreState
	Snapshot() (model.Document, error)
	ReplaceController(model.TokenRecord) error
	DeleteController() error
	UpsertExtender(string, model.TokenRecord) error
	DeleteExtender(string) error
	DeleteExtenders() error
}

type Enumerator interface {
	List(context.Context) ([]enumeration.Member, error)
	Invalidate()
}

type Service struct {
	store         Store
	enumerator    Enumerator
	now           func() time.Time
	proxy         *proxy.Proxy
	onMutation    func()
	controllerURL string
}

func NewService(store Store, enumerator Enumerator) *Service {
	return &Service{store: store, enumerator: enumerator, now: time.Now, controllerURL: DefaultControllerURL}
}

func (s *Service) SetMutationObserver(observer func()) { s.onMutation = observer }

func (s *Service) SetControllerURL(baseURL string) {
	if strings.TrimSpace(baseURL) == "" {
		s.controllerURL = DefaultControllerURL

		return
	}

	s.controllerURL = strings.TrimRight(baseURL, "/")
}

type ControllerVerdict string

const (
	ControllerValid        ControllerVerdict = "valid"
	ControllerInvalidToken ControllerVerdict = "invalid-token"
	ControllerUnsupported  ControllerVerdict = "unsupported-firmware"
	ControllerUnreachable  ControllerVerdict = "unreachable"
)

type ControllerTester interface {
	Test(context.Context, string) (ControllerVerdict, error)
}

func (s *Service) TestController(ctx context.Context, tester ControllerTester, token string) (ControllerVerdict, error) {
	if token == "" {
		return ControllerInvalidToken, nil
	}
	if tester == nil {
		return ControllerUnreachable, fmt.Errorf("controller tester unavailable")
	}
	return tester.Test(ctx, token)
}

func (s *Service) SaveController(ctx context.Context, tester ControllerTester, token string) (ControllerVerdict, error) {
	verdict, err := s.TestController(ctx, tester, token)
	if err != nil || verdict != ControllerValid {
		return verdict, err
	}
	checked := s.now().UTC()
	if err := s.store.ReplaceController(model.TokenRecord{
		Key:           "controller",
		Token:         token,
		Support:       model.SupportSupported,
		LastCheckedAt: &checked,
	}); err != nil {
		return ControllerUnreachable, err
	}
	s.notifyMutation()
	return verdict, nil
}

func (s *Service) Capability() (model.StoreState, model.Document) {
	state := s.store.State()
	document, err := s.store.Snapshot()
	if err != nil {
		return state, model.Document{Extenders: make(map[string]model.TokenRecord)}
	}
	return state, document
}

func (s *Service) Resolve(ctx context.Context, identity string) (proxy.Destination, error) {
	document, err := s.store.Snapshot()
	if err != nil {
		return proxy.Destination{}, err
	}
	if identity == "controller" {
		if document.Controller == nil || document.Controller.Token == "" {
			return proxy.Destination{}, proxy.ErrNoSession
		}
		if document.Controller.Support == model.SupportInvalid {
			return proxy.Destination{}, ErrControllerInvalid
		}
		if document.Controller.Support == model.SupportUnsupported {
			return proxy.Destination{}, proxy.ErrUnsupported
		}
		return proxy.Destination{BaseURL: s.controllerURL, Token: document.Controller.Token, Support: document.Controller.Support}, nil
	}
	record, ok := document.Extenders[identity]
	if !ok || record.Token == "" {
		return proxy.Destination{}, proxy.ErrNoSession
	}
	if record.Support == model.SupportUnsupported {
		return proxy.Destination{}, proxy.ErrUnsupported
	}
	if document.Controller != nil && document.Controller.Support == model.SupportInvalid {
		return proxy.Destination{}, ErrControllerInvalid
	}
	if s.enumerator == nil {
		return proxy.Destination{}, fmt.Errorf("%w: enumeration unavailable", proxy.ErrTargetUnreachable)
	}
	members, err := s.enumerator.List(ctx)
	if err != nil {
		return proxy.Destination{}, err
	}
	for _, member := range members {
		if member.Identity != identity {
			continue
		}
		resolved, err := target.Resolve(discovery.Member{CID: member.Identity, Name: member.Name, IP: member.IP, MAC: member.MAC})
		if err != nil {
			return proxy.Destination{}, fmt.Errorf("%w: unsafe member address", proxy.ErrTargetUnreachable)
		}
		return proxy.Destination{BaseURL: resolved.BaseURL, Token: record.Token, Support: record.Support}, nil
	}
	return proxy.Destination{}, fmt.Errorf("%w: member not found", proxy.ErrTargetUnreachable)
}

func (s *Service) Unauthorized(identity string) {
	document, err := s.store.Snapshot()
	if err != nil {
		return
	}
	if identity == "controller" {
		if document.Controller == nil {
			return
		}
		record := *document.Controller
		record.Support = model.SupportInvalid
		if err := s.store.ReplaceController(record); err == nil && s.enumerator != nil {
			s.enumerator.Invalidate()
			s.notifyMutation()
		}
		return
	}
	record, ok := document.Extenders[identity]
	if !ok {
		return
	}
	record.Key = ""
	record.Token = ""
	record.Support = model.SupportUnknown
	if err := s.store.UpsertExtender(identity, record); err == nil {
		s.notifyMutation()
	}
}

func (s *Service) DeleteController() error {
	if err := s.store.DeleteController(); err != nil {
		return err
	}
	s.notifyMutation()
	return nil
}

func (s *Service) DeleteExtenders() error {
	if err := s.store.DeleteExtenders(); err != nil {
		return err
	}
	s.notifyMutation()
	return nil
}

func (s *Service) DeleteExtender(identity string) error {
	if err := s.store.DeleteExtender(identity); err != nil {
		return err
	}
	s.notifyMutation()
	return nil
}

func (s *Service) Provision(ctx context.Context, generator minter.Generator, credentials minter.Credentials) ([]minter.Outcome, error) {
	if s.enumerator == nil {
		return nil, fmt.Errorf("%w: enumeration unavailable", proxy.ErrTargetUnreachable)
	}
	members, err := s.enumerator.List(ctx)
	if err != nil {
		return nil, err
	}
	outcomes := minter.Provision(ctx, generator, members, credentials)
	successes := 0
	for index := range outcomes {
		outcome := &outcomes[index]
		if outcome.Err != nil {
			continue
		}
		record := outcome.Record
		record.Support = model.SupportSupported
		if err := s.store.UpsertExtender(outcome.Member.Identity, record); err != nil {
			outcome.Err = err
			continue
		}
		s.notifyMutation()
		successes++
	}
	if successes == 0 && len(outcomes) > 0 {
		return outcomes, fmt.Errorf("all extender provisioning attempts failed")
	}
	return outcomes, nil
}

func (s *Service) Proxy(client *http.Client, maxResponseBytes int64, operationTimeout time.Duration) *proxy.Proxy {
	s.proxy = proxy.New(s, client, maxResponseBytes, operationTimeout)
	return s.proxy
}

func (s *Service) Do(ctx context.Context, request proxy.Request) (proxy.Response, error) {
	if s.proxy == nil {
		return proxy.Response{}, fmt.Errorf("persistent RCI proxy unavailable")
	}
	return s.proxy.Do(ctx, request)
}

func (s *Service) Targets(ctx context.Context) ([]socket.TargetSummary, error) {
	if s.enumerator == nil {
		return nil, fmt.Errorf("enumeration unavailable")
	}
	members, err := s.enumerator.List(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]socket.TargetSummary, 0, len(members))
	for _, member := range members {
		result = append(result, socket.TargetSummary{Identity: member.Identity, Name: member.Name, MAC: member.MAC})
	}
	return result, nil
}

func (s *Service) notifyMutation() {
	if s.onMutation != nil {
		s.onMutation()
	}
}
