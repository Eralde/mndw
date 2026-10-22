// Package enumeration lists the controller's mesh members, caching the result
// for a short TTL so a burst of session operations costs one upstream call.
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
	"mndwd/internal/rcisession/status"
)

var ErrTargetUnreachable = errors.New("target unreachable")

type Member struct {
	Identity             string
	Name                 string
	IP                   string
	FQDN                 string
	MAC                  string
	FQDNCertificateValid bool
	AuthTokenCapable     bool
}

type Source interface {
	Enumerate(context.Context) ([]Member, error)
}

type ControllerSnapshot struct {
	Active  bool
	BaseURL string
	Token   string
	Epoch   uint64
}

type ControllerHTTPError struct {
	Status int
	Epoch  uint64
}

func (e ControllerHTTPError) Error() string { return "controller request unauthorized" }

var ErrStaleResult = errors.New("stale controller result")

type CacheStatus struct {
	Stale           bool
	LastError       status.Category
	LastErrorAt     *time.Time
	LastGoodMembers []Member
}

type Cache struct {
	mu          sync.Mutex
	source      Source
	ttl         time.Duration
	now         func() time.Time
	members     []Member
	fetched     time.Time
	valid       bool
	stale       bool
	lastError   status.Category
	lastErrorAt *time.Time
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
		now := c.now()
		c.stale = true
		c.lastError = status.ControllerUnavailable
		c.lastErrorAt = &now

		return nil, fmt.Errorf("%w: enumeration source unavailable", ErrTargetUnreachable)
	}

	members, err := c.source.Enumerate(ctx)
	if err != nil {
		if !errors.Is(err, ErrStaleResult) {
			now := c.now()
			c.stale = true
			c.lastError = categorize(err)
			c.lastErrorAt = &now
		}

		var controllerError ControllerHTTPError

		if errors.As(err, &controllerError) {
			return nil, fmt.Errorf("%w: %w", ErrTargetUnreachable, controllerError)
		}

		return nil, fmt.Errorf("%w: enumeration failed", ErrTargetUnreachable)
	}

	if err := validateMembers(members); err != nil {
		now := c.now()
		c.stale = true
		c.lastError = status.MalformedResponse
		c.lastErrorAt = &now

		return nil, fmt.Errorf("%w: enumeration response invalid", ErrTargetUnreachable)
	}

	c.members = cloneMembers(members)
	c.fetched = c.now()
	c.valid = true
	c.stale = false
	c.lastError = ""
	c.lastErrorAt = nil

	return cloneMembers(c.members), nil
}

func (c *Cache) Invalidate() {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.valid = false
}

func (c *Cache) Status() CacheStatus {
	c.mu.Lock()

	defer c.mu.Unlock()

	return CacheStatus{
		Stale:           c.stale,
		LastError:       c.lastError,
		LastErrorAt:     cloneTime(c.lastErrorAt),
		LastGoodMembers: cloneMembers(c.members),
	}
}

func ParseMembers(data []byte) ([]Member, error) {
	members, err := discovery.ParseMembers(data)
	if err != nil {
		return nil, err
	}

	result := make([]Member, 0, len(members))

	for _, member := range members {
		result = append(result, Member{
			Identity:             member.Identity(),
			Name:                 member.Name,
			IP:                   member.IP,
			FQDN:                 member.FQDN,
			MAC:                  member.MAC,
			FQDNCertificateValid: member.FQDNCertificateValid,
			AuthTokenCapable:     member.AuthTokenCapable(),
		})
	}

	if err := validateMembers(result); err != nil {
		return nil, fmt.Errorf("%w: member validation failed", rci.ErrInvalidResponse)
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
	Client            *http.Client
	CaptureController func() ControllerSnapshot
	CurrentEpoch      func() uint64
	MaxResponseBytes  int64
}

func (s HTTPSource) Enumerate(ctx context.Context) ([]Member, error) {
	if s.CaptureController == nil {
		return nil, fmt.Errorf("controller session unavailable")
	}

	snapshot := s.CaptureController()

	if !snapshot.Active {
		return nil, fmt.Errorf("controller session unavailable")
	}

	controllerURL := strings.TrimRight(snapshot.BaseURL, "/")

	if controllerURL == "" {
		controllerURL = "http://127.0.0.1:79"
	}

	limit := s.MaxResponseBytes

	if limit <= 0 {
		limit = 1 << 20
	}

	options := []rci.HTTPOption{rci.WithMaxResponseBytes(limit)}

	if snapshot.Token != "" {
		options = append(options, rci.WithHeader("X-Ndma-Tkn", func() string { return snapshot.Token }))
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
	if err != nil {
		var httpErr *rci.HTTPError

		if errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusForbidden) {
			return nil, ControllerHTTPError{Status: httpErr.StatusCode, Epoch: snapshot.Epoch}
		}

		if !errors.Is(err, rci.ErrInvalidResponse) {
			return nil, err
		}
	}

	if s.CurrentEpoch != nil && s.CurrentEpoch() != snapshot.Epoch {
		return nil, ErrStaleResult
	}

	data := body

	if len(values) > 0 && values[0] != nil {
		data = values[0]
	}

	return ParseMembers(data)
}

func categorize(err error) status.Category {
	var controllerError ControllerHTTPError

	if errors.As(err, &controllerError) {
		if controllerError.Status == http.StatusUnauthorized || controllerError.Status == http.StatusForbidden {
			return status.Unauthorized
		}

		return status.ControllerUnavailable
	}

	var httpErr *rci.HTTPError

	if errors.As(err, &httpErr) {
		if httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusForbidden {
			return status.Unauthorized
		}

		return status.ControllerUnavailable
	}

	if errors.Is(err, rci.ErrInvalidResponse) {
		return status.MalformedResponse
	}

	return status.ControllerUnavailable
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}

	clone := *value

	return &clone
}
