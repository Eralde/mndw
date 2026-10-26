package main

import (
	"fmt"
	"net/http"
	"os"

	rci "mndw.local/rci"
	"mndwd/internal/mgmt"
	"mndwd/internal/telemetry"
)

type telemetryAssembly struct {
	capability *telemetry.Capability
	controller mgmt.TelemetryController
	err        error
}

func assembleTelemetry(core daemonCore, accessMux *http.ServeMux, session rciSessionAssembly) telemetryAssembly {
	return assembleTelemetryWith(core, accessMux, session, telemetry.NewCapability)
}

func assembleTelemetryWith(
	core daemonCore,
	accessMux *http.ServeMux,
	session rciSessionAssembly,
	newCapability func(telemetry.CapabilityConfig) (*telemetry.Capability, error),
) telemetryAssembly {
	if session.service == nil {
		return telemetryAssembly{}
	}

	client, err := newControllerRCIClient(session.service.Do)
	if err != nil {
		return telemetryAssembly{err: err}
	}

	capability, err := newCapability(telemetry.CapabilityConfig{
		RRDDir:             core.cfg.RRDDir,
		LoadSampler:        telemetry.NewLoadSampler(client),
		TemperatureSampler: telemetry.NewThermalSampler(osThermalReader{}, "/sys/class/thermal"),
		NTP:                telemetry.NewRCINTPSource(client),
		MaxUnsynced:        core.cfg.TelemetryMaxUnsynced,
		DesiredEnabled:     func() bool { return core.store.Snapshot().Settings.BackgroundTelemetry },
		SessionConfigured:  session.service.SessionPresent,
		Lifetime:           session.lifetime,
		Logger:             core.logger,
	})
	if err != nil {
		core.logger.Warn("telemetry unavailable", "error", err)

		return telemetryAssembly{}
	}

	telemetry.NewHandler(capability.SnapshotCache(), capability.IsEnabled, core.logger).Register(accessMux)

	return telemetryAssembly{
		capability: capability,
		controller: capability,
	}
}

func newControllerRCIClient(do telemetry.DoFunc) (*rci.Client, error) {
	client, err := rci.New(telemetry.NewControllerTransport(do))
	if err != nil {
		return nil, fmt.Errorf("create controller RCI client: %w", err)
	}

	return client, nil
}

type osThermalReader struct{}

func (osThermalReader) ReadDir(path string) ([]os.DirEntry, error) { return os.ReadDir(path) }
func (osThermalReader) ReadFile(path string) ([]byte, error)       { return os.ReadFile(path) }
