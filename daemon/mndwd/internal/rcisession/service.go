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
)

type Store interface {
	State() model.StoreState
	Snapshot() (model.Document, error)
	ReplaceController(model.TokenRecord) error
	DeleteController() error
}

type Enumerator interface {
	List(context.Context) ([]enumeration.Member, error)
	Invalidate()
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
	logger           *slog.Logger
}

func NewService(store Store, enumerator Enumerator) *Service {
	return &Service{store: store, enumerator: enumerator, now: time.Now, controllerURL: DefaultControllerURL, allowInsecure: true, manager: sessionmanager.New()}
}

func (s *Service) SetSessionManager(manager *sessionmanager.Manager) {
	s.mu.Lock()

	defer s.mu.Unlock()

	if manager != nil {
		s.manager = manager
	}
}

func (s *Service) SessionManager() *sessionmanager.Manager {
	s.mu.RLock()

	defer s.mu.RUnlock()

	return s.manager
}

func (s *Service) SetMutationObserver(observer func()) { s.onMutation = observer }

func (s *Service) SetLogger(logger *slog.Logger) {
	s.mu.Lock()

	defer s.mu.Unlock()

	s.logger = logger
}

func (s *Service) SetControllerClient(client *http.Client) {
	s.mu.Lock()

	defer s.mu.Unlock()

	s.controllerClient = client
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

		if snapshot.Token == "" {
			return proxy.Destination{}, proxy.ErrNoSession
		}

		if support == model.SupportInvalid {
			return proxy.Destination{}, ErrControllerInvalid
		}

		if support == model.SupportUnsupported {
			return proxy.Destination{}, proxy.ErrUnsupported
		}

		s.mu.RLock()

		allowInsecure := s.allowInsecure

		s.mu.RUnlock()

		return proxy.Destination{BaseURL: snapshot.BaseURL, Token: snapshot.Token, Support: support, AllowInsecure: allowInsecure, ControllerEpoch: snapshot.Epoch}, nil
	}

	return proxy.Destination{}, proxy.ErrNoSession
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

func (s *Service) loggerSnapshot() *slog.Logger {
	s.mu.RLock()

	defer s.mu.RUnlock()

	return s.logger
}

func (s *Service) InvalidateController(capturedEpoch uint64) {
	s.mu.Lock()

	if capturedEpoch != s.controllerEpoch {
		s.mu.Unlock()

		return
	}

	s.controllerEpoch++

	s.mu.Unlock()

	document, err := s.store.Snapshot()
	if err == nil && document.Controller != nil && document.Controller.Support != model.SupportInvalid {
		record := *document.Controller
		record.Support = model.SupportInvalid
		_ = s.store.ReplaceController(record)
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
	if err != nil || snapshot.Token == "" || support != model.SupportSupported {
		return enumeration.ControllerSnapshot{}
	}

	return snapshot
}

func (s *Service) captureController() (enumeration.ControllerSnapshot, model.Support, error) {
	document, err := s.store.Snapshot()
	if err != nil {
		return enumeration.ControllerSnapshot{}, model.SupportUnknown, err
	}

	s.mu.RLock()

	defer s.mu.RUnlock()

	if document.Controller == nil {
		return enumeration.ControllerSnapshot{BaseURL: s.controllerURL, Epoch: s.controllerEpoch}, model.SupportUnknown, nil
	}

	return enumeration.ControllerSnapshot{BaseURL: s.controllerURL, Token: document.Controller.Token, Epoch: s.controllerEpoch}, document.Controller.Support, nil
}

// AuthURL mints one controller-mediated extender relay URL. Returned errors
// are intentionally coarse except for the typed HTTP status used for epoch
// invalidation.
func (s *Service) AuthURL(ctx context.Context, identity string) (string, uint64, error) {
	snapshot := s.CaptureController()

	if snapshot.Token == "" || snapshot.BaseURL == "" {
		return "", snapshot.Epoch, fmt.Errorf("controller auth-url unavailable")
	}

	s.mu.RLock()

	controllerClient := s.controllerClient

	s.mu.RUnlock()

	options := []rci.HTTPOption{
		rci.WithHeader("X-Ndma-Tkn", func() string { return snapshot.Token }),
		rci.WithMaxResponseBytes(1 << 20),
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
