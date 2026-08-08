package daemon

import (
	"context"
	"time"

	"ping-widget/internal/model"
	"ping-widget/internal/persistence"
	"ping-widget/internal/ping"
)

const (
	pingInterval    = 5 * time.Second
	persistInterval = 20 * time.Second
)

// Server owns sampling and durable state. HTTP transport is implemented by
// internal/httpapi; this package has no child-facing socket protocol.
type Server struct {
	store *persistence.JSONStore
	state *ServiceState
}

func NewServer() (*Server, error) {
	store := persistence.NewDefaultStore()
	hosts, err := store.LoadHosts()
	if err != nil {
		return nil, err
	}
	samplesByHost, err := store.LoadStatsState()
	if err != nil {
		return nil, err
	}
	return &Server{store: store, state: NewServiceState(hosts, samplesByHost)}, nil
}

func (server *Server) Start(ctx context.Context) {
	go server.runPingLoop(ctx)
	go server.runPersistLoop(ctx)
}

func (server *Server) runPingLoop(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	run := func() {
		server.runPingCycle(func(hostIP string) model.Sample {
			return ping.RunOnce(hostIP, 4*time.Second)
		})
	}
	run()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func (server *Server) runPingCycle(run func(string) model.Sample) {
	if !server.state.Running() {
		return
	}
	for _, host := range server.state.PingTargets() {
		server.state.RecordSample(host.IP, run(host.IP))
	}
}

func (server *Server) runPersistLoop(ctx context.Context) {
	ticker := time.NewTicker(persistInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = server.Persist()
			return
		case <-ticker.C:
			_ = server.Persist()
		}
	}
}

func (server *Server) Stats() []model.HostStats { return server.state.Stats() }

func (server *Server) Hosts() []model.Host { return server.state.ListHosts() }

func (server *Server) Running() bool { return server.state.Running() }

func (server *Server) SetRunning(running bool) { server.state.SetRunning(running) }

func (server *Server) UpdateHosts(input model.HostUpdateInput) ([]model.Host, error) {
	hosts, err := server.state.ApplyHostUpdate(input)
	if err != nil {
		return nil, err
	}
	return hosts, server.Persist()
}

func (server *Server) Persist() error {
	if err := server.store.SaveHosts(server.state.HostSnapshot()); err != nil {
		return err
	}
	return server.store.SaveStatsState(server.state.SampleSnapshot())
}
