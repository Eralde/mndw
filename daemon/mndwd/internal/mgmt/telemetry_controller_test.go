package mgmt

import "mndwd/internal/telemetry"

var _ TelemetryController = (*telemetry.Capability)(nil)
