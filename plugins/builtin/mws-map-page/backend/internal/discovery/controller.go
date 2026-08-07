package discovery

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"mndw.local/device-auth"
	"mws-map-page/internal/session"
)

type Query func(context.Context, http.CookieJar) ([]byte, error)

type Controller struct {
	holder        *session.Holder
	target        auth.Target
	query         Query
	mu            sync.Mutex
	members       map[string]Member
	previous      map[string]Member
	lastConnected []Member
	interval      time.Duration
}

func NewController(holder *session.Holder, target auth.Target, query Query) *Controller {
	return &Controller{holder: holder, target: target, query: query, members: make(map[string]Member), previous: make(map[string]Member), interval: 30 * time.Second}
}

func (c *Controller) SetInterval(interval time.Duration) {
	if interval > 0 {
		c.interval = interval
	}
}

func (c *Controller) Poll(ctx context.Context) error {
	if c.holder == nil || c.query == nil {
		return errors.New("controller discovery is not configured")
	}
	var data []byte
	err := c.holder.WithSession(ctx, "controller", c.target, func(operationCtx context.Context, jar http.CookieJar) error {
		var err error
		data, err = c.query(operationCtx, jar)
		return err
	})
	if err != nil {
		return err
	}
	members, err := ParseMembers(data)
	if err != nil {
		return err
	}
	next := make(map[string]Member, len(members))
	for _, member := range members {
		member.Online = member.IP != ""
		next[member.Identity()] = member
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.previous = c.members
	c.members = next
	c.lastConnected = c.lastConnected[:0]
	for id, old := range c.previous {
		if old.Online && (!next[id].Online || next[id].Identity() == "") {
			c.lastConnected = append(c.lastConnected, old)
		}
	}
	return nil
}

func (c *Controller) Run(ctx context.Context) error {
	if err := c.Poll(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := c.Poll(ctx); err != nil {
				continue
			}
		}
	}
}

func (c *Controller) Members() []Member {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]Member, 0, len(c.members))
	for _, member := range c.members {
		result = append(result, member)
	}
	return result
}

func (c *Controller) LastConnected() []Member {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Member(nil), c.lastConnected...)
}
