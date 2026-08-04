package enumeration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"mndwd/internal/keenetic/discovery"
)

var ErrTargetUnreachable = errors.New("target unreachable")

type Member struct {
	Identity string
	Name     string
	IP       string
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
		result = append(result, Member{Identity: member.Identity(), Name: member.Name, IP: member.IP, MAC: member.MAC})
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
		if member.Identity == "" || member.IP == "" || !macPattern.MatchString(member.MAC) || net.ParseIP(member.IP) == nil {
			return fmt.Errorf("member identity, MAC, and IP are required")
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

const memberQueryBody = `[{"show":{"mws":{"member":{}}}}]`

func (s HTTPSource) Enumerate(ctx context.Context) ([]Member, error) {
	if s.ControllerToken == nil || s.ControllerToken() == "" {
		return nil, fmt.Errorf("controller session unavailable")
	}
	client := s.Client
	if client == nil {
		client = &http.Client{}
	}
	baseURL := strings.TrimRight(s.ControllerURL, "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:79"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/rci/", strings.NewReader(memberQueryBody))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Ndma-Tkn", s.ControllerToken())
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("controller enumeration returned status")
	}
	limit := s.MaxResponseBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, fmt.Errorf("controller enumeration response invalid")
	}
	return parseMemberResponse(data)
}

func parseMemberResponse(data []byte) ([]Member, error) {
	var envelope []struct {
		Show struct {
			MWS struct {
				Member json.RawMessage `json:"member"`
			} `json:"mws"`
		} `json:"show"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil {
		for _, item := range envelope {
			if item.Show.MWS.Member != nil {
				return ParseMembers(item.Show.MWS.Member)
			}
		}
	}

	return ParseMembers(data)
}
