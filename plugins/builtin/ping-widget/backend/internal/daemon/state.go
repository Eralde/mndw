package daemon

import (
	"errors"
	"math"
	"sort"
	"strings"
	"sync"

	"ping-widget/internal/model"
)

const maxSamplesPerHost = 60

type ServiceState struct {
	mu          sync.RWMutex
	hosts       map[string]model.Host
	orderedIPs  []string
	samplesByIP map[string][]model.Sample
	running     bool
}

func NewServiceState(hosts []model.Host, samplesByIP map[string][]model.Sample) *ServiceState {
	state := &ServiceState{
		hosts:       map[string]model.Host{},
		orderedIPs:  make([]string, 0, len(hosts)),
		samplesByIP: map[string][]model.Sample{},
		running:     true,
	}

	for _, host := range hosts {
		if host.IP == "" {
			continue
		}
		state.hosts[host.IP] = host
		state.orderedIPs = append(state.orderedIPs, host.IP)
	}

	for ip, samples := range samplesByIP {
		if _, exists := state.hosts[ip]; !exists {
			continue
		}
		state.samplesByIP[ip] = trimSamples(samples)
	}

	return state
}

func (state *ServiceState) ApplyHostUpdate(input model.HostUpdateInput) ([]model.Host, error) {
	state.mu.Lock()
	defer state.mu.Unlock()

	action := strings.TrimSpace(strings.ToLower(input.Action))
	ip := strings.TrimSpace(input.IP)
	name := strings.TrimSpace(input.Name)

	if ip == "" {
		return nil, errors.New("ip is required")
	}

	switch action {
	case "add":
		if _, exists := state.hosts[ip]; exists {
			return nil, errors.New("host already exists")
		}
		host := model.Host{IP: ip, Name: name}
		state.hosts[ip] = host
		state.orderedIPs = append(state.orderedIPs, ip)
		state.samplesByIP[ip] = []model.Sample{}
	case "update":
		host, exists := state.hosts[ip]
		if !exists {
			return nil, errors.New("host does not exist")
		}
		host.Name = name
		state.hosts[ip] = host
	case "remove":
		if _, exists := state.hosts[ip]; !exists {
			return nil, errors.New("host does not exist")
		}
		delete(state.hosts, ip)
		delete(state.samplesByIP, ip)
		nextOrder := make([]string, 0, len(state.orderedIPs))
		for _, candidate := range state.orderedIPs {
			if candidate != ip {
				nextOrder = append(nextOrder, candidate)
			}
		}
		state.orderedIPs = nextOrder
	default:
		return nil, errors.New("action must be add, update, or remove")
	}

	return state.listHostsUnsafe(), nil
}

func (state *ServiceState) ListHosts() []model.Host {
	state.mu.RLock()
	defer state.mu.RUnlock()

	return state.listHostsUnsafe()
}

func (state *ServiceState) Running() bool {
	state.mu.RLock()
	defer state.mu.RUnlock()

	return state.running
}

func (state *ServiceState) SetRunning(running bool) {
	state.mu.Lock()
	defer state.mu.Unlock()

	state.running = running
}

func (state *ServiceState) RecordSample(ip string, sample model.Sample) {
	state.mu.Lock()
	defer state.mu.Unlock()

	if _, exists := state.hosts[ip]; !exists {
		return
	}

	samples := append(state.samplesByIP[ip], sample)
	state.samplesByIP[ip] = trimSamples(samples)
}

func (state *ServiceState) Stats() []model.HostStats {
	state.mu.RLock()
	defer state.mu.RUnlock()

	stats := make([]model.HostStats, 0, len(state.orderedIPs))
	for _, ip := range state.orderedIPs {
		host := state.hosts[ip]
		samples := state.samplesByIP[ip]
		stats = append(stats, buildStats(host, samples))
	}

	return stats
}

func (state *ServiceState) HostSnapshot() []model.Host {
	state.mu.RLock()
	defer state.mu.RUnlock()

	return state.listHostsUnsafe()
}

func (state *ServiceState) SampleSnapshot() map[string][]model.Sample {
	state.mu.RLock()
	defer state.mu.RUnlock()

	snapshot := make(map[string][]model.Sample, len(state.samplesByIP))
	for ip, samples := range state.samplesByIP {
		copied := make([]model.Sample, len(samples))
		copy(copied, samples)
		snapshot[ip] = copied
	}

	return snapshot
}

func (state *ServiceState) PingTargets() []model.Host {
	return state.ListHosts()
}

func (state *ServiceState) listHostsUnsafe() []model.Host {
	hosts := make([]model.Host, 0, len(state.orderedIPs))
	for _, ip := range state.orderedIPs {
		host, exists := state.hosts[ip]
		if exists {
			hosts = append(hosts, host)
		}
	}
	return hosts
}

func trimSamples(samples []model.Sample) []model.Sample {
	if len(samples) <= maxSamplesPerHost {
		return samples
	}
	return samples[len(samples)-maxSamplesPerHost:]
}

func buildStats(host model.Host, samples []model.Sample) model.HostStats {
	stats := model.HostStats{
		IP:          host.IP,
		Name:        host.Name,
		SampleCount: len(samples),
	}

	if len(samples) == 0 {
		return stats
	}

	failed := 0
	updatedAt := samples[len(samples)-1].At
	latencies := make([]float64, 0, len(samples))

	for _, sample := range samples {
		if !sample.Success {
			failed++
			continue
		}
		latencies = append(latencies, sample.LatencyMs)
		stats.LastMs = sample.LatencyMs
		updatedAt = sample.At
	}

	stats.UpdatedAt = updatedAt
	if len(samples) > 0 {
		stats.LossPercent = roundTo2(float64(failed) * 100 / float64(len(samples)))
	}

	if len(latencies) == 0 {
		return stats
	}

	minValue := latencies[0]
	maxValue := latencies[0]
	sum := 0.0
	sortedLatencies := make([]float64, len(latencies))
	copy(sortedLatencies, latencies)

	for _, value := range latencies {
		sum += value
		if value < minValue {
			minValue = value
		}
		if value > maxValue {
			maxValue = value
		}
	}

	sort.Float64s(sortedLatencies)
	median := sortedLatencies[len(sortedLatencies)/2]
	if len(sortedLatencies)%2 == 0 {
		upper := sortedLatencies[len(sortedLatencies)/2]
		lower := sortedLatencies[(len(sortedLatencies)/2)-1]
		median = (upper + lower) / 2
	}

	stats.AvgMs = roundTo2(sum / float64(len(latencies)))
	stats.MedianMs = roundTo2(median)
	stats.MinMs = roundTo2(minValue)
	stats.MaxMs = roundTo2(maxValue)

	return stats
}

func roundTo2(value float64) float64 {
	return math.Round(value*100) / 100
}
