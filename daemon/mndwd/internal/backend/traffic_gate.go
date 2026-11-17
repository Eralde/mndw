package backend

import (
	"github.com/coder/websocket"
)

type socketCloser interface {
	Close(code websocket.StatusCode, reason string) error
}

type TrafficGate struct {
	supervisor *Supervisor
}

func NewTrafficGate() *TrafficGate {
	config := normalizeSupervisorConfig(SupervisorConfig{})

	return newTrafficGate(newSupervisor(config, NewAdmission(config.Limits)))
}

func newTrafficGate(supervisor *Supervisor) *TrafficGate {
	return &TrafficGate{supervisor: supervisor}
}

func (g *TrafficGate) Track(conn socketCloser, pluginID string) (func(), bool) {
	return g.supervisor.trackSocket(conn, pluginID)
}

func (g *TrafficGate) ClosePlugin(pluginID string) {
	g.supervisor.closePluginSockets(pluginID)
}

func (g *TrafficGate) BeginPlatformMaintenance() {
	g.supervisor.beginPlatformMaintenance()
}

func (g *TrafficGate) PlatformMaintenance() bool {
	return g.supervisor.platformMaintenanceActive()
}

func closeSockets(connections []socketCloser) {
	for _, conn := range connections {
		_ = conn.Close(websocket.StatusServiceRestart, "mndw updating")
	}
}
