package main

import (
	"fmt"
	"net/http"
	"os"

	rci "mndw.local/rci"
	"mndwd/internal/mgmt"
	"mndwd/internal/telemetry"
	"mndwd/internal/telemetry/annotations"
	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/sessions"
)

type telemetryAssembly struct {
	capability  *telemetry.Capability
	controller  mgmt.TelemetryController
	annotations *annotations.Store
	err         error
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

	policy := telemetry.DefaultPolicy()

	if core.cfg.TelemetryMaxUnsynced > 0 {
		policy.MaxUnsynced = core.cfg.TelemetryMaxUnsynced
	}

	capability, err := newCapability(telemetry.CapabilityConfig{
		RRDDir:             core.cfg.RRDDir,
		LoadSampler:        telemetry.NewLoadSampler(client),
		TemperatureSampler: telemetry.NewThermalSampler(osThermalReader{}, "/sys/class/thermal"),
		Clock:              clock.NewBootClock(),
		Evidence:           telemetry.NewRCIEvidenceSource(client),
		Policy:             policy,
		DesiredEnabled:     func() bool { return core.store.Snapshot().Settings.BackgroundTelemetry },
		SessionConfigured:  session.service.SessionPresent,
		Lifetime:           session.lifetime,
		Logger:             core.logger,
	})
	if err != nil {
		core.logger.Warn("telemetry unavailable", "error", err)

		return telemetryAssembly{}
	}

	annotationStore, err := annotations.NewStore(annotations.Config{
		RRDDir:  core.cfg.RRDDir,
		Catalog: annotations.DefaultCatalog{},
		Logger:  core.logger,
	})
	if err != nil {
		core.logger.Warn("telemetry annotation store unavailable", "error", err)

		annotationStore = nil
	}

	telemetry.NewHandler(capability.SnapshotCache(), capability.IsEnabled, annotationStore, core.logger).Register(accessMux)
	sessions.RegisterRoutes(accessMux, capability.SessionReader(), core.logger)

	return telemetryAssembly{
		capability:  capability,
		controller:  capability,
		annotations: annotationStore,
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
