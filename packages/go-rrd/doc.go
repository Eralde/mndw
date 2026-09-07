// Package rrd provides a bounded, shell-free RRDtool command adapter: file
// creation, schema validation, update execution, and info/fetch queries.
//
// Acquisition scheduling, retention, and clock trust are the responsibility of
// the daemon telemetry package; this package owns no collector. Sampling and
// scheduling policy were moved to daemon telemetry, which journals records
// before publishing them into RRD files.
package rrd
