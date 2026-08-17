package sessionmanager

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/heartbeat"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/rcisession/status"
	"mndwd/internal/target"
)

type State string

const (
	StateOffline      State = "offline"
	StateEstablishing State = "establishing"
	StateLive         State = "live"
	StateDead         State = "dead"
)

type MemberStatus struct {
	Identity         string
	Name             string
	Eligible         bool
	Reason           string
	Online           bool
	FQDN             string
	CertValid        bool
	AuthTokenCapable bool
}

type Candidate struct {
	BaseURL string
	Jar     http.CookieJar
	Client  *http.Client
}

type Options struct {
	Now     func() time.Time
	Jitter  func(time.Duration) time.Duration
	Context context.Context
}

type session struct {
	state             State
	baseURL           string
	jar               http.CookieJar
	client            *http.Client
	generation        uint64
	lastError         status.Category
	lastHeartbeatAt   *time.Time
	backoffUntil      *time.Time
	consecutiveErrors int
	establishCancel   context.CancelFunc
	heartbeatCancel   context.CancelFunc
}

type SnapshotMember struct {
	Identity         string
	Name             string
	Eligible         bool
	Reason           string
	Online           bool
	FQDN             string
	CertValid        bool
	AuthTokenCapable bool
	State            State
	Generation       uint64
	LastError        status.Category
	LastHeartbeatAt  *time.Time
	HasSession       bool
}

type Snapshot struct {
	Members []SnapshotMember
}

func (s Snapshot) Member(identity string) SnapshotMember {
	for _, member := range s.Members {
		if member.Identity == identity {
			return member
		}
	}

	return SnapshotMember{Identity: identity}
}

type Manager struct {
	mu          sync.Mutex
	members     map[string]MemberStatus
	sessions    map[string]*session
	now         func() time.Time
	jitter      func(time.Duration) time.Duration
	baseContext context.Context
	epoch       uint64
	nextHandle  uint64
}

func New(options ...Options) *Manager {
	config := Options{}
	if len(options) > 0 {
		config = options[0]
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Jitter == nil {
		config.Jitter = func(value time.Duration) time.Duration { return value }
	}
	if config.Context == nil {
		config.Context = context.Background()
	}

	return &Manager{
		members:     make(map[string]MemberStatus),
		sessions:    make(map[string]*session),
		now:         config.Now,
		jitter:      config.Jitter,
		baseContext: config.Context,
	}
}

func NewManager(options ...Options) *Manager {
	return New(options...)
}

func (m *Manager) ApplyEnumeration(values []enumeration.Member) {
	m.mu.Lock()
	defer m.mu.Unlock()

	next := make(map[string]MemberStatus, len(values))
	discarded := false
	for _, member := range values {
		fqdn := normalizedFQDN(member.FQDN)
		statusValue := MemberStatus{
			Identity:         member.Identity,
			Name:             member.Name,
			Online:           member.IP != "",
			FQDN:             fqdn,
			CertValid:        member.FQDNCertificateValid,
			AuthTokenCapable: member.AuthTokenCapable,
		}
		statusValue.Eligible, statusValue.Reason = eligibility(statusValue)
		next[member.Identity] = statusValue

		current, exists := m.members[member.Identity]
		changed := !exists || current.FQDN != statusValue.FQDN || current.CertValid != statusValue.CertValid || current.AuthTokenCapable != statusValue.AuthTokenCapable
		if changed || !statusValue.Eligible || !statusValue.Online {
			if m.sessions[member.Identity] != nil {
				m.discardSessionLocked(member.Identity)
				discarded = true
			}
		}
	}

	for identity := range m.members {
		if _, exists := next[identity]; !exists {
			if m.sessions[identity] != nil {
				m.discardSessionLocked(identity)
				discarded = true
			}
		}
	}
	m.members = next
	if discarded {
		m.epoch++
	}
}

func (m *Manager) BeginEstablishment(identity string, tickEpoch uint64) (context.Context, uint64, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if tickEpoch != m.epoch {
		return nil, m.epoch, false
	}
	member, exists := m.members[identity]
	if !exists || !member.Eligible || !member.Online {
		return nil, m.epoch, false
	}
	if current := m.sessions[identity]; current != nil {
		if current.state == StateEstablishing || current.state == StateLive {
			return nil, m.epoch, false
		}
		if current.backoffUntil != nil && m.now().Before(*current.backoffUntil) {
			return nil, m.epoch, false
		}
	}

	ctx, cancel := context.WithCancel(m.baseContext)
	m.sessions[identity] = &session{
		state:           StateEstablishing,
		generation:      m.nextGenerationLocked(),
		establishCancel: cancel,
	}
	return ctx, m.epoch, true
}

func (m *Manager) CommitEstablishment(identity string, epoch uint64, generation uint64, candidate Candidate) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.sessions[identity]
	member, memberOK := m.members[identity]
	if epoch != m.epoch || current == nil || current.state != StateEstablishing || current.generation != generation || !memberOK || !member.Eligible || !member.Online || candidate.Client == nil || candidate.Jar == nil || !strings.HasPrefix(candidate.BaseURL, "https://") {
		return false
	}
	current.state = StateLive
	current.baseURL = strings.TrimRight(candidate.BaseURL, "/")
	current.jar = candidate.Jar
	current.client = candidate.Client
	current.lastError = ""
	current.backoffUntil = nil
	current.consecutiveErrors = 0
	if current.establishCancel != nil {
		current.establishCancel()
		current.establishCancel = nil
	}

	return true
}

func (m *Manager) FailEstablishment(identity string, epoch uint64, category status.Category, immediate bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if epoch != m.epoch {
		return
	}
	current := m.sessions[identity]
	if current == nil || current.state != StateEstablishing {
		return
	}
	current.lastError = safeCategory(category)
	current.state = StateDead
	current.consecutiveErrors++
	if immediate {
		current.backoffUntil = nil
	} else {
		current.backoffUntil = m.backoffLocked(current.consecutiveErrors)
	}
	if current.establishCancel != nil {
		current.establishCancel()
		current.establishCancel = nil
	}
	current.generation = m.nextGenerationLocked()
}

func (m *Manager) LiveHeartbeatTargets() []heartbeat.Target {
	m.mu.Lock()
	defer m.mu.Unlock()

	targets := make([]heartbeat.Target, 0)
	for identity, current := range m.sessions {
		if current.state != StateLive || current.client == nil {
			continue
		}
		if current.heartbeatCancel != nil {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		ctx = heartbeat.WithBaseURL(ctx, current.baseURL)
		current.heartbeatCancel = cancel
		targets = append(targets, heartbeat.Target{Identity: identity, Client: current.client, Generation: current.generation, Context: ctx})
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].Identity < targets[j].Identity })

	return targets
}

func (m *Manager) CommitHeartbeat(identity string, generation uint64, result heartbeat.Result) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.sessions[identity]
	if current == nil || current.state != StateLive || current.generation != generation {
		return
	}
	if current.heartbeatCancel != nil {
		current.heartbeatCancel()
		current.heartbeatCancel = nil
	}
	if result.Unauthorized {
		m.markDeadLocked(current, status.Unauthorized, true)
		return
	}
	if result.Transient || result.Err != nil || result.Status < http.StatusOK || result.Status >= http.StatusMultipleChoices {
		current.lastError = status.Transient
		current.consecutiveErrors++
		if current.consecutiveErrors >= 2 {
			m.markDeadLocked(current, status.Transient, false)
		}
		return
	}
	now := m.now()
	current.lastHeartbeatAt = &now
	current.lastError = ""
	current.consecutiveErrors = 0
}

func (m *Manager) Resolve(identity string) (proxy.Destination, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	member, exists := m.members[identity]
	if exists && !member.Eligible {
		return proxy.Destination{}, proxy.ErrUnsupported
	}
	current := m.sessions[identity]
	if !exists || current == nil || current.state != StateLive || current.client == nil {
		return proxy.Destination{}, proxy.ErrNoSession
	}

	return proxy.Destination{
		BaseURL:    current.baseURL,
		Client:     current.client,
		Support:    "supported",
		Generation: current.generation,
	}, nil
}

func (m *Manager) HasMember(identity string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.members[identity]
	return ok
}

func (m *Manager) Unauthorized(identity string, generation uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.sessions[identity]
	if current == nil || current.state != StateLive || current.generation != generation {
		return
	}
	m.markDeadLocked(current, status.Unauthorized, true)
}

func (m *Manager) Discard(identity string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.discardSessionLocked(identity)
	m.epoch++
}

func (m *Manager) DiscardAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for identity := range m.sessions {
		m.discardSessionLocked(identity)
	}
	m.sessions = make(map[string]*session)
	m.epoch++
}

func (m *Manager) BumpForControllerTokenChange() {
	m.DiscardAll()
}

func (m *Manager) Snapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()

	identities := make([]string, 0, len(m.members))
	for identity := range m.members {
		identities = append(identities, identity)
	}
	sort.Strings(identities)
	result := Snapshot{Members: make([]SnapshotMember, 0, len(identities))}
	for _, identity := range identities {
		member := m.members[identity]
		item := SnapshotMember{
			Identity:         member.Identity,
			Name:             member.Name,
			Eligible:         member.Eligible,
			Reason:           member.Reason,
			Online:           member.Online,
			FQDN:             member.FQDN,
			CertValid:        member.CertValid,
			AuthTokenCapable: member.AuthTokenCapable,
		}
		if member.Eligible {
			item.State = StateOffline
			if member.Online {
				item.State = StateEstablishing
			}
		}
		if current := m.sessions[identity]; current != nil && member.Eligible {
			item.State = current.state
			item.Generation = current.generation
			item.LastError = current.lastError
			item.LastHeartbeatAt = cloneTime(current.lastHeartbeatAt)
			item.HasSession = true
		}
		result.Members = append(result.Members, item)
	}

	return result
}

func (m *Manager) Epoch() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.epoch
}

func (m *Manager) nextGenerationLocked() uint64 {
	m.nextHandle++
	return m.nextHandle
}

func (m *Manager) discardSessionLocked(identity string) {
	current := m.sessions[identity]
	if current == nil {
		return
	}
	if current.establishCancel != nil {
		current.establishCancel()
	}
	if current.heartbeatCancel != nil {
		current.heartbeatCancel()
	}
	delete(m.sessions, identity)
}

func (m *Manager) markDeadLocked(current *session, category status.Category, immediate bool) {
	current.state = StateDead
	current.lastError = safeCategory(category)
	current.jar = nil
	current.client = nil
	current.consecutiveErrors++
	if immediate {
		current.backoffUntil = nil
	} else {
		current.backoffUntil = m.backoffLocked(current.consecutiveErrors)
	}
	if current.heartbeatCancel != nil {
		current.heartbeatCancel()
		current.heartbeatCancel = nil
	}
	current.generation = m.nextGenerationLocked()
}

func (m *Manager) backoffLocked(strikes int) *time.Time {
	delay := 10 * time.Second
	for index := 1; index < strikes; index++ {
		delay *= 2
		if delay >= 5*time.Minute {
			delay = 5 * time.Minute
			break
		}
	}
	delay = m.jitter(delay)
	value := m.now().Add(delay)
	return &value
}

func eligibility(member MemberStatus) (bool, string) {
	if member.FQDN == "" {
		return false, "missing-fqdn"
	}
	if !member.CertValid {
		return false, "certificate-invalid"
	}
	if !member.AuthTokenCapable {
		return false, "no-auth-token"
	}
	return true, ""
}

func normalizedFQDN(value string) string {
	value = strings.TrimSpace(strings.ToLower(strings.TrimRight(value, ".")))
	if value == "" {
		return ""
	}
	if normalized, err := target.NormalizeFQDN(value); err == nil {
		return normalized
	}
	return ""
}

func safeCategory(value status.Category) status.Category {
	if status.IsValid(value) {
		return value
	}
	return status.MalformedResponse
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}
