package enumeration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/discovery"
)

var ErrTargetUnreachable = errors.New("target unreachable")

type Member struct {
	Identity string
	Name     string
	IP       string
	FQDN     string
	MAC      string
}

type Source interface {
	Enumerate(context.Context) ([]Member, error)
}

type Cache struct {
	mu      sync.Mutex
	source  Source
	ttl     time.Duration
	now     func() time.Time
	members []Member
	fetched time.Time
	valid   bool
}

func NewCache(source Source, ttl time.Duration, now func() time.Time) *Cache {
	if now == nil {
		now = time.Now
	}
	return &Cache{source: source, ttl: ttl, now: now}
}

func (c *Cache) List(ctx context.Context) ([]Member, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.valid && c.ttl > 0 && c.now().Sub(c.fetched) < c.ttl {
		return cloneMembers(c.members), nil
	}
	if c.source == nil {
		return nil, fmt.Errorf("%w: enumeration source unavailable", ErrTargetUnreachable)
	}
	members, err := c.source.Enumerate(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: enumeration failed", ErrTargetUnreachable)
	}
	if err := validateMembers(members); err != nil {
		return nil, fmt.Errorf("%w: enumeration response invalid", ErrTargetUnreachable)
	}
	c.members = cloneMembers(members)
	c.fetched = c.now()
	c.valid = true
	return cloneMembers(c.members), nil
}

func (c *Cache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.valid = false
}

func ParseMembers(data []byte) ([]Member, error) {
	members, err := discovery.ParseMembers(data)
	if err != nil {
		return nil, err
	}
	result := make([]Member, 0, len(members))
	for _, member := range members {
		result = append(result, Member{Identity: member.Identity(), Name: member.Name, IP: member.IP, FQDN: member.FQDN, MAC: member.MAC})
	}
	if err := validateMembers(result); err != nil {
		return nil, err
	}
	return result, nil
}

var macPattern = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

func validateMembers(members []Member) error {
	seen := make(map[string]struct{}, len(members))
	for _, member := range members {
		if member.Identity == "" || !macPattern.MatchString(member.MAC) || (member.IP != "" && net.ParseIP(member.IP) == nil) {
			return fmt.Errorf("member identity and MAC are required; IP must be valid when present")
		}
		if _, exists := seen[member.Identity]; exists {
			return fmt.Errorf("member identity is ambiguous")
		}
		seen[member.Identity] = struct{}{}
	}
	return nil
}

func cloneMembers(members []Member) []Member {
	return append([]Member(nil), members...)
}

type JSONSource struct {
	Fetch func(context.Context) ([]byte, error)
}

func (s JSONSource) Enumerate(ctx context.Context) ([]Member, error) {
	if s.Fetch == nil {
		return nil, fmt.Errorf("enumeration fetch unavailable")
	}
	data, err := s.Fetch(ctx)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage = data
	return ParseMembers(raw)
}

type HTTPSource struct {
	Client           *http.Client
	ControllerURL    string
	ControllerToken  func() string
	MaxResponseBytes int64
}

func (s HTTPSource) Enumerate(ctx context.Context) ([]Member, error) {
	if s.ControllerToken == nil || s.ControllerToken() == "" {
		return nil, fmt.Errorf("controller session unavailable")
	}
	controllerURL := strings.TrimRight(s.ControllerURL, "/")
	if controllerURL == "" {
		controllerURL = "http://127.0.0.1:79"
	}
	limit := s.MaxResponseBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	options := []rci.HTTPOption{
		rci.WithHeader("X-Ndma-Tkn", s.ControllerToken),
		rci.WithMaxResponseBytes(limit),
	}
	if s.Client != nil {
		options = append(options, rci.WithHTTPClient(s.Client))
	}
	transport, err := rci.NewHTTPTransport(controllerURL, options...)
	if err != nil {
		return nil, err
	}
	client, err := rci.New(transport)
	if err != nil {
		return nil, err
	}
	values, body, err := client.ExecuteRaw(ctx, rci.Q("show.mws.member"))
	if err != nil && !errors.Is(err, rci.ErrInvalidResponse) {
		return nil, err
	}
	data := body
	if len(values) > 0 && values[0] != nil {
		data = values[0]
	}
	return ParseMembers(data)
}
