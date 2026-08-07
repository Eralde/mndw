package cli

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"ping-widget/internal/daemon"
	"ping-widget/internal/model"
	"ping-widget/internal/persistence"
)

func StartDaemon() (model.Response, error) {
	if pid, running := daemon.ReadRunningPid(); running {
		return model.Response{
			Success: true,
			Data: map[string]any{
				"alreadyRunning": true,
				"pid":            pid,
			},
			Message: "Daemon already running",
		}, nil
	}

	command := exec.Command(os.Args[0], "daemon-run")
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := command.Start(); err != nil {
		return model.Response{}, err
	}

	ready := daemon.WaitForSocket(2 * time.Second)
	return model.Response{
		Success: ready,
		Data: map[string]any{
			"alreadyRunning": false,
			"pid":            command.Process.Pid,
		},
		Message: map[bool]string{true: "Daemon started", false: "Daemon start requested"}[ready],
	}, nil
}

func StopDaemon() (model.Response, error) {
	if _, running := daemon.ReadRunningPid(); !running {
		return model.Response{
			Success: true,
			Data: map[string]any{
				"alreadyStopped": true,
			},
			Message: "Daemon already stopped",
		}, nil
	}

	response, err := Send(model.Request{Cmd: "stop"})
	if err != nil {
		return model.Response{}, err
	}
	return response, nil
}

func Stats() (model.Response, error) {
	store := persistence.NewDefaultStore()
	return statsWithFallback(
		func() (model.Response, error) {
			return Send(model.Request{Cmd: "stats"})
		},
		store.LoadHosts,
		store.LoadStatsState,
	)
}

func HostsList() (model.Response, error) {
	store := persistence.NewDefaultStore()
	return hostsListWithFallback(
		func() (model.Response, error) {
			return Send(model.Request{Cmd: "hosts-list"})
		},
		store.LoadHosts,
	)
}

func HostsUpdate(reader io.Reader) (model.Response, error) {
	input, err := ParseHostUpdate(reader)
	if err != nil {
		return model.Response{}, err
	}

	if input.Action == "" || input.IP == "" {
		return model.Response{}, errors.New("action and ip are required")
	}

	return Send(model.Request{Cmd: "hosts-update", Body: input})
}

func PersistNow() (model.Response, error) {
	return Send(model.Request{Cmd: "persist-now"})
}

func hostsListWithFallback(
	requestHosts func() (model.Response, error),
	loadStoredHosts func() ([]model.Host, error),
) (model.Response, error) {
	response, err := requestHosts()
	if err == nil {
		return response, nil
	}

	hosts, loadErr := loadStoredHosts()
	if loadErr != nil {
		return model.Response{}, loadErr
	}

	return model.Response{
		Success: true,
		Data:    hosts,
		Message: "Hosts loaded from stored state",
	}, nil
}

func statsWithFallback(
	requestStats func() (model.Response, error),
	loadStoredHosts func() ([]model.Host, error),
	loadStoredSamples func() (map[string][]model.Sample, error),
) (model.Response, error) {
	response, err := requestStats()
	if err == nil {
		return response, nil
	}

	hosts, hostsErr := loadStoredHosts()
	if hostsErr != nil {
		return model.Response{}, hostsErr
	}

	samples, samplesErr := loadStoredSamples()
	if samplesErr != nil {
		return model.Response{}, samplesErr
	}

	fallbackStats := daemon.NewServiceState(hosts, samples).Stats()
	return model.Response{
		Success: true,
		Data:    fallbackStats,
		Message: "Stats loaded from stored state",
	}, nil
}
