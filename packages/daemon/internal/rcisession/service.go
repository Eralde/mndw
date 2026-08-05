package rcisession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"mndwd/internal/keenetic/discovery"
	"mndwd/internal/keenetic/target"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/minter"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/rcisession/socket"
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
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultControllerURL
	}
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" {
		return "", false, fmt.Errorf("controller URL must be an absolute HTTP(S) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", false, fmt.Errorf("controller URL must contain only scheme and host")
	}
	allowInsecure := parsed.Scheme == "http" && (isLoopbackHost(parsed.Hostname()) || allowRemoteHTTP)
	if parsed.Scheme == "http" && !allowInsecure {
		return "", false, fmt.Errorf("remote HTTP controller URL is not permitted")
	}
	return strings.TrimRight(parsed.String(), "/"), allowInsecure, nil
}

func isLoopbackHost(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
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
	s.notifyMutation("controller-token-saved")
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
			s.logTokenInvalidated("controller")
			s.notifyMutation("controller-token-invalidated")
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
		s.logTokenInvalidated(identity)
		s.notifyMutation("extender-token-invalidated")
	}
}

func (s *Service) DeleteController() error {
	if err := s.store.DeleteController(); err != nil {
		return err
	}
	s.notifyMutation("controller-token-deleted")
	return nil
}

func (s *Service) DeleteExtenders(ctx context.Context) error {
	document, err := s.store.Snapshot()
	if err != nil {
		return err
	}
	if len(document.Extenders) == 0 {
		if err := s.store.DeleteExtenders(); err != nil {
			return err
		}
		s.notifyMutation("extender-record-deleted")
		return nil
	}

	var failures []error
	for identity, record := range document.Extenders {
		if record.Token == "" {
			if err := s.store.DeleteExtender(identity); err != nil {
				failures = append(failures, fmt.Errorf("%w: %s: remove inactive local record: %v", ErrExtenderTokenDeletion, identity, err))
				continue
			}
			s.notifyMutation("extender-token-deleted")
			continue
		}
		if record.Key == "" {
			failures = append(failures, fmt.Errorf("%w: %s: token ID is missing", ErrExtenderTokenDeletion, identity))
			continue
		}
		if s.proxy == nil {
			failures = append(failures, fmt.Errorf("%w: %s: proxy unavailable", ErrExtenderTokenDeletion, identity))
			continue
		}

		response, err := s.proxy.Do(ctx, proxy.Request{
			Target: identity,
			Method: http.MethodPost,
			Path:   "rci/",
			Body:   tokenDeleteRequestBody(record.Key),
		})
		tokenAlreadyInvalid := errors.Is(err, proxy.ErrSessionInvalid)
		if tokenAlreadyInvalid {
			// A rejected token is already unusable; remove its local record.
			err = nil
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("%w: %s: remote revoke: %v", ErrExtenderTokenDeletion, identity, err))
			continue
		}
		if !tokenAlreadyInvalid && (response.Status < http.StatusOK || response.Status >= http.StatusMultipleChoices) {
			failures = append(failures, fmt.Errorf("%w: %s: remote revoke returned HTTP %d", ErrExtenderTokenDeletion, identity, response.Status))
			continue
		}
		if err := s.store.DeleteExtender(identity); err != nil {
			failures = append(failures, fmt.Errorf("%w: %s: remove local record: %v", ErrExtenderTokenDeletion, identity, err))
			continue
		}
		s.notifyMutation("extender-token-deleted")
	}
	return errors.Join(failures...)
}

func tokenDeleteRequestBody(id string) []byte {
	body, _ := json.Marshal(map[string]any{
		"authentication": map[string]any{
			"token": map[string]any{
				"delete": map[string]string{"id": id},
			},
		},
	})
	return body
}

func (s *Service) DeleteExtender(identity string) error {
	if err := s.store.DeleteExtender(identity); err != nil {
		return err
	}
	s.notifyMutation("extender-record-deleted")
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
			outcome.Reason = minter.ReasonUnreachable
			continue
		}
		s.notifyMutation("extender-token-created")
		successes++
	}
	if successes == 0 && len(outcomes) > 0 {
		allPolicyRefusals := true
		for _, outcome := range outcomes {
			if !errors.Is(outcome.Err, minter.ErrPersistentTokenRequiresHTTPS) && !errors.Is(outcome.Err, minter.ErrMemberOffline) {
				allPolicyRefusals = false
				break
			}
		}
		if !allPolicyRefusals {
			return outcomes, fmt.Errorf("all extender provisioning attempts failed")
		}
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
