package backend

import (
	"sync"

	"github.com/coder/websocket"
)

type socketCloser interface {
	Close(code websocket.StatusCode, reason string) error
}

type TrafficGate struct {
	mu                  sync.Mutex
	active              map[socketCloser]string
	platformMaintenance bool
}

func NewTrafficGate() *TrafficGate {
	return &TrafficGate{active: make(map[socketCloser]string)}
}

func (g *TrafficGate) Track(conn socketCloser, pluginID string) (func(), bool) {
	g.mu.Lock()

	if g.platformMaintenance {
		g.mu.Unlock()

		return func() {}, false
	}

	g.active[conn] = pluginID

	g.mu.Unlock()

	return func() {
		g.mu.Lock()
		delete(g.active, conn)
		g.mu.Unlock()
	}, true
}

func (g *TrafficGate) ClosePlugin(pluginID string) {
	g.mu.Lock()

	connections := make([]socketCloser, 0)

	for conn, activePluginID := range g.active {
		if activePluginID == pluginID {
			connections = append(connections, conn)
		}
	}

	g.mu.Unlock()

	closeSockets(connections)
}

func (g *TrafficGate) BeginPlatformMaintenance() {
	g.mu.Lock()

	g.platformMaintenance = true
	connections := make([]socketCloser, 0, len(g.active))

	for conn := range g.active {
		connections = append(connections, conn)
	}

	g.mu.Unlock()

	closeSockets(connections)
}

func (g *TrafficGate) PlatformMaintenance() bool {
	g.mu.Lock()

	defer g.mu.Unlock()

	return g.platformMaintenance
}

func closeSockets(connections []socketCloser) {
	for _, conn := range connections {
		_ = conn.Close(websocket.StatusServiceRestart, "mndw updating")
	}
}
