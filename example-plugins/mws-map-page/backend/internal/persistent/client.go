package persistent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const protocolVersion = 1

type Target struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	MAC      string `json:"mac"`
}

type Session struct {
	Mac  string `json:"mac"`
	Live bool   `json:"live"`
}

type Config struct {
	Path         string
	PluginID     string
	PollInterval time.Duration
	RetryDelay   time.Duration
	IOTimeout    time.Duration
	MaxInflight  int
	Dial         func(context.Context) (net.Conn, error)
}

type Client struct {
	config Config

	mu       sync.Mutex
	targets  map[string]Target
	sessions map[string]sessionState
}

type sessionState struct {
	target Target
	misses int
	live   bool
}

type wireFrame struct {
	Hello   *wireHello      `json:"hello,omitempty"`
	ID      int64           `json:"id,omitempty"`
	Op      string          `json:"op,omitempty"`
	Target  string          `json:"target,omitempty"`
	Method  string          `json:"method,omitempty"`
	Path    string          `json:"path,omitempty"`
	Status  int             `json:"status,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Targets []Target        `json:"targets,omitempty"`
	Error   *wireError      `json:"error,omitempty"`
}

type wireHello struct {
	PluginID string `json:"pluginId,omitempty"`
	Proto    int    `json:"proto"`
	OK       bool   `json:"ok,omitempty"`
}

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type remoteError struct {
	code string
}

func (e *remoteError) Error() string { return e.code }

func New(config Config) *Client {
	if config.PollInterval <= 0 {
		config.PollInterval = 30 * time.Second
	}
	if config.RetryDelay <= 0 {
		config.RetryDelay = time.Second
	}
	if config.IOTimeout <= 0 {
		config.IOTimeout = 5 * time.Second
	}
	if config.MaxInflight <= 0 {
		config.MaxInflight = 8
	}
	return &Client{config: config, targets: make(map[string]Target), sessions: make(map[string]sessionState)}
}

func (c *Client) Run(ctx context.Context) {
	if c == nil || c.config.PluginID == "" {
		return
	}
	for {
		if ctx.Err() != nil {
			c.clear()
			return
		}
		c.clear()
		if err := c.runConnection(ctx); err != nil && ctx.Err() == nil {
			c.wait(ctx, c.config.RetryDelay)
		}
	}
}

func (c *Client) Snapshot() []Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]Session, 0, len(c.sessions))
	for _, state := range c.sessions {
		if !state.live {
			continue
		}
		result = append(result, Session{Mac: state.target.MAC, Live: true})
	}
	for _, state := range c.sessions {
		if state.live || state.misses < 2 {
			continue
		}
		result = append(result, Session{Mac: state.target.MAC, Live: false})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Mac < result[j].Mac })
	return result
}

func (c *Client) runConnection(ctx context.Context) error {
	connection, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	defer c.clear()
	if err := c.handshake(connection); err != nil {
		return err
	}
	rpc := newRPC(connection)
	defer rpc.close()

	for {
		frame, err := rpc.call(ctx, wireFrame{Op: "targets"})
		if err != nil {
			return err
		}
		if err := c.updateTargets(frame.Targets); err != nil {
			return err
		}
		c.pollTargets(ctx, rpc)
		if err := c.wait(ctx, c.config.PollInterval); err != nil {
			return err
		}
	}
}

func (c *Client) dial(ctx context.Context) (net.Conn, error) {
	if c.config.Dial != nil {
		return c.config.Dial(ctx)
	}
	if c.config.Path == "" {
		return nil, errors.New("persistent session socket disabled")
	}
	return (&net.Dialer{Timeout: c.config.IOTimeout}).DialContext(ctx, "unix", c.config.Path)
}

func (c *Client) handshake(connection net.Conn) error {
	if err := connection.SetDeadline(time.Now().Add(c.config.IOTimeout)); err != nil {
		return err
	}
	if err := writeFrame(connection, wireFrame{Hello: &wireHello{PluginID: c.config.PluginID, Proto: protocolVersion}}); err != nil {
		return err
	}
	var response wireFrame
	if err := json.NewDecoder(bufio.NewReader(connection)).Decode(&response); err != nil {
		return err
	}
	if response.Hello == nil || response.Hello.Proto != protocolVersion || !response.Hello.OK {
		return errors.New("persistent session hello rejected")
	}
	return connection.SetDeadline(time.Time{})
}

func (c *Client) updateTargets(targets []Target) error {
	current := make(map[string]Target, len(targets))
	for _, target := range targets {
		if target.Identity == "" {
			return errors.New("persistent session target has no identity")
		}
		target.MAC = normalizeMAC(target.MAC)
		if target.MAC == "" {
			continue
		}
		current[target.Identity] = target
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for identity := range c.targets {
		if _, ok := current[identity]; !ok {
			delete(c.sessions, identity)
		}
	}
	for identity, target := range current {
		state, ok := c.sessions[identity]
		if !ok {
			state = sessionState{}
		}
		state.target = target
		c.sessions[identity] = state
	}
	c.targets = current
	return nil
}

func (c *Client) pollTargets(ctx context.Context, rpc *rpcConnection) {
	c.mu.Lock()
	targets := make([]Target, 0, len(c.targets))
	for _, target := range c.targets {
		targets = append(targets, target)
	}
	c.mu.Unlock()
	semaphore := make(chan struct{}, c.config.MaxInflight)
	var workers sync.WaitGroup
	for _, target := range targets {
		target := target
		workers.Add(1)
		go func() {
			defer workers.Done()
			select {
			case semaphore <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-semaphore }()
			response, err := rpc.call(ctx, wireFrame{Target: target.Identity, Method: "GET", Path: "rci/show/version"})
			c.applyResult(target, response, err)
		}()
	}
	workers.Wait()
}

func (c *Client) applyResult(target Target, response wireFrame, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state, ok := c.sessions[target.Identity]
	if !ok {
		return
	}
	if err == nil && response.Status == 200 {
		state.misses = 0
		state.live = true
		c.sessions[target.Identity] = state
		return
	}
	var remote *remoteError
	if errors.As(err, &remote) && (remote.code == "no-session-for-target" || remote.code == "unsupported-firmware" || remote.code == "not-permitted") {
		delete(c.sessions, target.Identity)
		return
	}
	if errors.As(err, &remote) && remote.code != "session-invalid" && remote.code != "target-unreachable" {
		return
	}
	state.misses++
	if state.misses >= 2 {
		state.live = false
	}
	c.sessions[target.Identity] = state
}

func (c *Client) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.targets = make(map[string]Target)
	c.sessions = make(map[string]sessionState)
}

func (c *Client) wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func normalizeMAC(value string) string {
	address, err := net.ParseMAC(value)
	if err != nil || len(address) != 6 {
		return ""
	}
	return address.String()
}

func writeFrame(connection net.Conn, frame wireFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	_, err = connection.Write(append(data, '\n'))
	return err
}

type rpcConnection struct {
	connection net.Conn
	nextID     atomic.Int64
	writeMu    sync.Mutex
	pendingMu  sync.Mutex
	pending    map[int64]chan wireFrame
	done       chan struct{}
	closeOnce  sync.Once
}

func newRPC(connection net.Conn) *rpcConnection {
	rpc := &rpcConnection{connection: connection, pending: make(map[int64]chan wireFrame), done: make(chan struct{})}
	go rpc.readLoop()
	return rpc
}

func (r *rpcConnection) call(ctx context.Context, request wireFrame) (wireFrame, error) {
	id := r.nextID.Add(1)
	request.ID = id
	response := make(chan wireFrame, 1)
	r.pendingMu.Lock()
	r.pending[id] = response
	r.pendingMu.Unlock()
	r.writeMu.Lock()
	err := writeFrame(r.connection, request)
	r.writeMu.Unlock()
	if err != nil {
		r.removePending(id)
		return wireFrame{}, err
	}
	select {
	case frame := <-response:
		if frame.Error != nil {
			return frame, &remoteError{code: frame.Error.Code}
		}
		return frame, nil
	case <-ctx.Done():
		r.removePending(id)
		return wireFrame{}, ctx.Err()
	case <-r.done:
		r.removePending(id)
		return wireFrame{}, errors.New("persistent session socket closed")
	}
}

func (r *rpcConnection) readLoop() {
	decoder := json.NewDecoder(bufio.NewReader(r.connection))
	for {
		var frame wireFrame
		if err := decoder.Decode(&frame); err != nil {
			r.close()
			return
		}
		r.pendingMu.Lock()
		response, ok := r.pending[frame.ID]
		if ok {
			delete(r.pending, frame.ID)
		}
		r.pendingMu.Unlock()
		if ok {
			response <- frame
		}
	}
}

func (r *rpcConnection) removePending(id int64) {
	r.pendingMu.Lock()
	delete(r.pending, id)
	r.pendingMu.Unlock()
}

func (r *rpcConnection) close() {
	r.closeOnce.Do(func() {
		close(r.done)
		_ = r.connection.Close()
	})
}
