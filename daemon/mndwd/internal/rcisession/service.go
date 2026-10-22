// Package rcisession owns controller persistence and RAM-only extender sessions.
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

	rci "mndw.local/rci"
	"mndw.local/rcisock"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/establisher"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/rcisession/sessionmanager"
)

var (
	ErrControllerInvalid = errors.New("controller session invalid")
	ErrAuthModeMismatch  = errors.New("controller auth mode mismatch")
)

type Store interface {
	State() model.StoreState
	Snapshot() (model.Document, error)
	ReplaceController(model.TokenRecord) error
	DeleteController() error
}

type EnabledStore interface {
	PersistentRCIEnabled() (bool, bool)
	SetPersistentRCIEnabled(bool) error
}

type AuthModeSource interface {
	Mode() AuthMode
	Detect(context.Context) AuthMode
}

type Enumerator interface {
	List(context.Context) ([]enumeration.Member, error)
	Invalidate()
}

type ServiceConfig struct {
	Store            Store
	HTTPClient       *http.Client
	ControllerURL    string
	MaxResponseBytes int64
	OperationTimeout time.Duration
	EnumerationTTL   time.Duration
	Manager          *sessionmanager.Manager
	Enumerator       Enumerator
	EnabledStore     EnabledStore
	AuthModeSource   AuthModeSource
	Logger           *slog.Logger
	Now              func() time.Time
}

type Service struct {
	store            Store
	enumerator       Enumerator
	now              func() time.Time
	proxy            *proxy.Proxy
	onMutation       func()
	mu               sync.RWMutex
	controllerURL    string
	allowInsecure    bool
	controllerClient *http.Client
	manager          *sessionmanager.Manager
	controllerEpoch  uint64
	enabledStore     EnabledStore
	authModeSource   AuthModeSource
	authModeNotified bool
	logger           *slog.Logger
}

func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Store == nil {
		return nil, errors.New("rcisession: Store is required")
	}

	controllerURL := cfg.ControllerURL

	if controllerURL == "" {
		controllerURL = DefaultControllerURL
	}

	parsedControllerURL, err := ValidateControllerURLShape(controllerURL)
	if err != nil {
		return nil, fmt.Errorf("rcisession: controller URL: %w", err)
	}

	controllerURL = strings.TrimRight(parsedControllerURL.String(), "/")

	now := cfg.Now

	if now == nil {
		now = time.Now
	}

	manager := cfg.Manager

	if manager == nil {
		manager = sessionmanager.New()
	}

	service := &Service{
		store:            cfg.Store,
		now:              now,
		controllerURL:    controllerURL,
		allowInsecure:    parsedControllerURL.Scheme == "http",
		controllerClient: cfg.HTTPClient,
		manager:          manager,
		enabledStore:     cfg.EnabledStore,
		authModeSource:   cfg.AuthModeSource,
		authModeNotified: cfg.AuthModeSource != nil && cfg.AuthModeSource.Mode() != AuthModeUnknown,
		logger:           cfg.Logger,
	}

	var proxyClient interface {
		Do(*http.Request) (*http.Response, error)
	}

	if cfg.HTTPClient != nil {
		proxyClient = cfg.HTTPClient
	}

	service.proxy = proxy.New(service, proxyClient, cfg.MaxResponseBytes, cfg.OperationTimeout)

	enumerator := cfg.Enumerator

	if enumerator == nil {
		enumerator = enumeration.NewCache(enumeration.HTTPSource{
			Client:            cfg.HTTPClient,
			MaxResponseBytes:  cfg.MaxResponseBytes,
			CaptureController: service.CaptureController,
			CurrentEpoch:      service.ControllerEpoch,
		}, cfg.EnumerationTTL, now)
	}

	service.enumerator = enumerator

	return service, nil
}

func (s *Service) Enumerator() Enumerator {
	return s.enumerator
}

func (s *Service) AuthMode() AuthMode {
	source := s.authModeSource

	if source == nil {
		return AuthModeToken
	}

	return source.Mode()
}

func (s *Service) DetectAuthMode(ctx context.Context) AuthMode {
	source := s.authModeSource

	if source == nil {
		return AuthModeToken
	}

	mode := source.Detect(ctx)
	shouldNotify := false

	if mode != AuthModeUnknown {
		s.mu.Lock()

		if !s.authModeNotified {
			s.authModeNotified = true
			s.controllerEpoch++
			shouldNotify = true
		}

		s.mu.Unlock()
	}

	if shouldNotify {
		s.notifyMutation("auth-mode-detected")
	}

	return mode
}

func (s *Service) Enabled() bool {
	mode := s.AuthMode()

	if mode != AuthModeToken && mode != AuthModeNone {
		return false
	}

	if enabledStore := s.enabledStore; enabledStore != nil {
		enabled, set := enabledStore.PersistentRCIEnabled()

		if set {
			return enabled
		}
	}

	if mode == AuthModeNone {
		return false
	}

	document, err := s.store.Snapshot()

	return err == nil && document.Controller != nil && document.Controller.Token != ""
}

func (s *Service) SessionPresent() bool {
	switch s.AuthMode() {
	case AuthModeNone:
		return s.Enabled()
	case AuthModeToken:
		if !s.Enabled() {
			return false
		}

		document, err := s.store.Snapshot()

		return err == nil && document.Controller != nil && document.Controller.Token != ""
	default:
		return false
	}
}

func (s *Service) ControllerSupport() model.Support {
	switch s.AuthMode() {
	case AuthModeNone:
		if s.Enabled() {
			return model.SupportSupported
		}

		return model.SupportUnknown
	case AuthModeToken:
		document, err := s.store.Snapshot()
		if err != nil {
			return model.SupportUnknown
		}

		if document.Controller == nil {
			if s.Enabled() {
				return model.SupportNeedsToken
			}

			return model.SupportUnknown
		}

		if document.Controller.Token == "" && s.Enabled() {
			return model.SupportNeedsToken
		}

		return document.Controller.Support
	default:
		return model.SupportUnknown
	}
}

func (s *Service) SetTokenlessEnabled(ctx context.Context, tester ControllerTester, enabled bool) (ControllerVerdict, error) {
	if s.DetectAuthMode(ctx) != AuthModeNone {
		return ControllerUnreachable, ErrAuthModeMismatch
	}

	enabledStore := s.enabledStore

	if enabledStore == nil {
		return ControllerUnreachable, fmt.Errorf("persistent RCI enabled store unavailable")
	}

	verdict := ControllerValid

	if enabled {
		if tester == nil {
			return ControllerUnreachable, fmt.Errorf("controller tester unavailable")
		}

		var err error
		verdict, err = tester.Test(ctx, "")
		if err != nil || verdict != ControllerValid {
			return verdict, err
		}
	}

	if err := enabledStore.SetPersistentRCIEnabled(enabled); err != nil {
		return ControllerUnreachable, err
	}

	s.bumpControllerEpoch()

	if !enabled {
		if manager := s.SessionManager(); manager != nil {
			manager.DiscardAll()
		}

		if s.enumerator != nil {
			s.enumerator.Invalidate()
		}

		s.notifyMutation("tokenless-disabled")

		return verdict, nil
	}

	s.notifyMutation("tokenless-enabled")

	return verdict, nil
}

func (s *Service) SessionManager() *sessionmanager.Manager {
	return s.manager
}

func (s *Service) SubscribeMutations(observer func()) {
	s.mu.Lock()

	s.onMutation = observer

	s.mu.Unlock()
}

func (s *Service) Capability() (model.StoreState, model.Document) {
	state := s.store.State()
	document, err := s.store.Snapshot()
	if err != nil {
		return state, model.Document{}
	}

	return state, document
}

func (s *Service) Resolve(_ context.Context, identity string) (proxy.Destination, error) {
	if identity != "controller" {
		manager := s.SessionManager()

		if manager != nil && manager.HasMember(identity) {
			return manager.Resolve(identity)
		}

		return proxy.Destination{}, proxy.ErrNoSession
	}

	if identity == "controller" {
		snapshot, support, err := s.captureController()
		if err != nil {
			return proxy.Destination{}, err
		}

		if !s.SessionPresent() || support == model.SupportNeedsToken {
			return proxy.Destination{}, proxy.ErrNoSession
		}

		if support == model.SupportInvalid {
			return proxy.Destination{}, ErrControllerInvalid
		}

		if support == model.SupportUnsupported {
			return proxy.Destination{}, proxy.ErrUnsupported
		}

		return proxy.Destination{Controller: true, BaseURL: snapshot.BaseURL, Token: snapshot.Token, Support: support, AllowInsecure: s.allowInsecure, ControllerEpoch: snapshot.Epoch}, nil
	}

	return proxy.Destination{}, proxy.ErrNoSession
}

func (s *Service) Do(ctx context.Context, request proxy.Request) (proxy.Response, error) {
	return s.proxy.Do(ctx, request)
}

func (s *Service) Targets(ctx context.Context) ([]rcisock.Target, error) {
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
	if logger := s.logger; logger != nil {
		logger.Info("persistent RCI session mutation", "reason", reason)
	}

	s.mu.RLock()

	observer := s.onMutation

	s.mu.RUnlock()

	if observer != nil {
		observer()
	}
}

func (s *Service) InvalidateController(capturedEpoch uint64) {
	mode := s.AuthMode()

	s.mu.Lock()

	if capturedEpoch != s.controllerEpoch {
		s.mu.Unlock()

		return
	}

	s.controllerEpoch++

	s.mu.Unlock()

	if mode != AuthModeNone {
		document, err := s.store.Snapshot()
		if err == nil && document.Controller != nil && document.Controller.Support != model.SupportInvalid {
			record := *document.Controller
			record.Support = model.SupportInvalid
			_ = s.store.ReplaceController(record)
		}
	}

	if s.enumerator != nil {
		s.enumerator.Invalidate()
	}

	if manager := s.SessionManager(); manager != nil {
		manager.DiscardAll()
	}

	s.notifyMutation("controller-token-invalidated")
}

func (s *Service) ControllerEpoch() uint64 {
	s.mu.RLock()

	defer s.mu.RUnlock()

	return s.controllerEpoch
}

// CaptureController snapshots controller trust inputs for one request. The
// token and epoch are read together so late results can be fenced.
func (s *Service) CaptureController() enumeration.ControllerSnapshot {
	snapshot, support, err := s.captureController()
	if err != nil || !snapshot.Active || support != model.SupportSupported {
		return enumeration.ControllerSnapshot{}
	}

	return snapshot
}

func (s *Service) captureController() (enumeration.ControllerSnapshot, model.Support, error) {
	s.mu.RLock()

	epoch := s.controllerEpoch

	s.mu.RUnlock()

	snapshot := enumeration.ControllerSnapshot{BaseURL: s.controllerURL, Epoch: epoch}

	switch s.AuthMode() {
	case AuthModeNone:
		support := model.SupportUnknown

		if s.Enabled() {
			support = model.SupportSupported
			snapshot.Active = true
		}

		return snapshot, support, nil
	case AuthModeToken:
		document, err := s.store.Snapshot()
		if err != nil {
			return enumeration.ControllerSnapshot{}, model.SupportUnknown, err
		}

		if document.Controller == nil {
			if s.Enabled() {
				return snapshot, model.SupportNeedsToken, nil
			}

			return snapshot, model.SupportUnknown, nil
		}

		snapshot.Token = document.Controller.Token
		snapshot.Active = s.Enabled() && snapshot.Token != "" && document.Controller.Support == model.SupportSupported

		return snapshot, document.Controller.Support, nil
	default:
		return snapshot, model.SupportUnknown, nil
	}
}

// AuthURL mints one controller-mediated extender relay URL. Returned errors
// are intentionally coarse except for the typed HTTP status used for epoch
// invalidation.
func (s *Service) AuthURL(ctx context.Context, identity string) (string, uint64, error) {
	snapshot := s.CaptureController()

	if !snapshot.Active || snapshot.BaseURL == "" {
		return "", snapshot.Epoch, fmt.Errorf("controller auth-url unavailable")
	}

	controllerClient := s.controllerClient

	options := []rci.HTTPOption{rci.WithMaxResponseBytes(1 << 20)}

	if snapshot.Token != "" {
		options = append(options, rci.WithHeader("X-Ndma-Tkn", func() string { return snapshot.Token }))
	}

	if controllerClient != nil {
		options = append(options, rci.WithHTTPClient(controllerClient))
	}

	transport, err := rci.NewHTTPTransport(snapshot.BaseURL, options...)
	if err != nil {
		return "", snapshot.Epoch, fmt.Errorf("controller auth-url unavailable")
	}

	client, err := rci.New(transport)
	if err != nil {
		return "", snapshot.Epoch, fmt.Errorf("controller auth-url unavailable")
	}

	values, _, err := client.ExecuteRaw(ctx, rci.Q("mws.member.auth-url", map[string]string{"member": identity}))
	if err != nil {
		var httpErr *rci.HTTPError

		if errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusForbidden) {
			return "", snapshot.Epoch, httpErr
		}

		if errors.Is(err, rci.ErrInvalidResponse) || errors.Is(err, rci.ErrResponseTooLarge) {
			return "", snapshot.Epoch, establisher.AuthURLResponseError{}
		}

		return "", snapshot.Epoch, fmt.Errorf("controller auth-url unavailable")
	}

	if len(values) == 0 || values[0] == nil {
		return "", snapshot.Epoch, establisher.AuthURLResponseError{}
	}

	rawURL, err := establisher.ParseAuthURLResponse(values[0])
	if err != nil {
		return "", snapshot.Epoch, establisher.AuthURLResponseError{}
	}

	if s.ControllerEpoch() != snapshot.Epoch {
		return "", snapshot.Epoch, establisher.StaleControllerResultError{}
	}

	return rawURL, snapshot.Epoch, nil
}
