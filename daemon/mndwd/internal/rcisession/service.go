// Package rcisession owns the device's persistent RCI credentials — the tokens
// mndwd uses to talk to the mesh controller and its extenders on the user's
// behalf. Service is the orchestration core: it reads and writes the encrypted
// record (sub-package store), mints tokens (minter), lists mesh members with a
// short-lived cache (enumeration), and forwards capped outbound RCI requests
// (proxy). The socket sub-package exposes an authenticated session to builtin
// plugins that hold the persistent-RCI permission, and reconciles those unix
// sockets as the credential state changes. handler.go serves the /api/mndw RCI
// endpoints; controller.go tests controller reachability.
package rcisession

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"mndw.local/rcisock"
	"mndwd/internal/discovery"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/target"
)

var (
	ErrControllerInvalid     = errors.New("controller session invalid")
	ErrExtenderTokenDeletion = errors.New("extender token deletion failed")
)

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
	mu            sync.RWMutex
	controllerURL string
	allowInsecure bool
	logger        *slog.Logger
}

func NewService(store Store, enumerator Enumerator) *Service {
	return &Service{store: store, enumerator: enumerator, now: time.Now, controllerURL: DefaultControllerURL, allowInsecure: true}
}

func (s *Service) SetMutationObserver(observer func()) { s.onMutation = observer }

func (s *Service) SetLogger(logger *slog.Logger) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logger = logger
}

func (s *Service) SetControllerURL(baseURL string, allowRemoteHTTP bool) error {
	validatedURL, allowInsecure, err := validateControllerURL(baseURL, allowRemoteHTTP)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.controllerURL = validatedURL
	s.allowInsecure = allowInsecure
	s.mu.Unlock()
	return nil
}

func validateControllerURL(baseURL string, allowRemoteHTTP bool) (string, bool, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		baseURL = DefaultControllerURL
	}
	parsed, err := ValidateControllerURLShape(baseURL)
	if err != nil {
		return "", false, err
	}
	allowInsecure := parsed.Scheme == "http" && (IsLoopbackHost(parsed.Hostname()) || allowRemoteHTTP)
	if parsed.Scheme == "http" && !allowInsecure {
		return "", false, fmt.Errorf("remote HTTP controller URL is not permitted")
	}
	return strings.TrimRight(parsed.String(), "/"), allowInsecure, nil
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
		s.mu.RLock()
		controllerURL := s.controllerURL
		allowInsecure := s.allowInsecure
		s.mu.RUnlock()
		return proxy.Destination{BaseURL: controllerURL, Token: document.Controller.Token, Support: document.Controller.Support, AllowInsecure: allowInsecure}, nil
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
		if strings.TrimSpace(member.FQDN) == "" {
			if strings.TrimSpace(member.IP) == "" {
				return proxy.Destination{}, fmt.Errorf("%w: member has no reachable endpoint", proxy.ErrTargetUnreachable)
			}
			return proxy.Destination{}, proxy.ErrSecureEndpointUnavailable
		}
		resolved, err := target.Resolve(discovery.Member{CID: member.Identity, Name: member.Name, IP: member.IP, FQDN: member.FQDN, MAC: member.MAC})
		if err != nil {
			return proxy.Destination{}, fmt.Errorf("%w: unsafe member address", proxy.ErrTargetUnreachable)
		}
		return proxy.Destination{BaseURL: resolved.BaseURL, Token: record.Token, Support: record.Support}, nil
	}
	return proxy.Destination{}, fmt.Errorf("%w: member not found", proxy.ErrTargetUnreachable)
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

func (s *Service) Targets(ctx context.Context) ([]rcisock.Target, error) {
	if s.enumerator == nil {
		return nil, fmt.Errorf("enumeration unavailable")
	}
	members, err := s.enumerator.List(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]rcisock.Target, 0, len(members))
	for _, member := range members {
		result = append(result, rcisock.Target{Identity: member.Identity, Name: member.Name, MAC: member.MAC})
	}
	return result, nil
}

func (s *Service) notifyMutation(reason string) {
	if logger := s.loggerSnapshot(); logger != nil {
		logger.Info("persistent RCI session mutation", "reason", reason)
	}
	if s.onMutation != nil {
		s.onMutation()
	}
}

func (s *Service) logTokenInvalidated(identity string) {
	if logger := s.loggerSnapshot(); logger != nil {
		logger.Warn("persistent RCI token invalidated", "identity", identity)
	}
}

func (s *Service) loggerSnapshot() *slog.Logger {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.logger
}
