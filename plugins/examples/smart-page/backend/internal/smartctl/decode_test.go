package smartctl

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"smart-page/internal/model"
)

type decodeFixture struct {
	name        string
	file        string
	exitCode    int
	protocol    model.Protocol
	health      model.Health
	temperature *float64
	powerHours  *string
}

func floatPointer(value float64) *float64 {
	return &value
}

func stringPointer(value string) *string {
	return &value
}

func intPointer(value int) *int {
	return &value
}

func TestDecodeRotationRateFromFixtures(t *testing.T) {
	tests := []struct {
		name string
		file string
		code int
		want *int
	}{
		{name: "ATA SSD", file: "ata-ssd.json", want: intPointer(0)},
		{name: "ATA HDD", file: "ata-hdd.json", want: intPointer(5200)},
		{name: "SCSI HDD", file: "scsi-usb-hdd.json", want: intPointer(5200)},
		{name: "SCSI T7", file: "scsi-usb-nvme.json", code: 4, want: intPointer(0)},
		{name: "health failed", file: "health-failed.json", code: 8, want: intPointer(7200)},
		{name: "NVMe field absent", file: "nvme-usb-asmedia.json", want: nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sample, err := Decode(readCommandResult(t, test.file, test.code), time.Now())
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}

			assertRotationRate(t, sample, test.want)
		})
	}
}

func TestDecodeRotationRateInvalidValuesDoNotFailSCSI(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
	}{
		{name: "negative", value: "-1"},
		{name: "fraction", value: "1.5"},
		{name: "string", value: `"7200"`},
		{name: "above maximum", value: "200000"},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := readCommandResult(t, "scsi-usb-hdd.json", 0)
			result.Stdout = []byte(strings.Replace(string(result.Stdout), `"rotation_rate": 5200`, `"rotation_rate": `+test.value, 1))

			sample, err := Decode(result, time.Now())
			if err != nil {
				t.Fatalf("Decode() error = %v, want malformed hint to be ignored", err)
			}

			assertRotationRate(t, sample, nil)
		})
	}
}

func TestDecodeRotationRateAcceptsMaximumAndIgnoresNVMeField(t *testing.T) {
	tests := []struct {
		name     string
		file     string
		code     int
		mutation func([]byte) []byte
		want     *int
	}{
		{
			name: "maximum",
			file: "scsi-usb-hdd.json",
			mutation: func(data []byte) []byte {
				return []byte(strings.Replace(string(data), `"rotation_rate": 5200`, `"rotation_rate": 100000`, 1))
			},
			want: intPointer(100000),
		},
		{
			name: "NVMe field present",
			file: "nvme-usb-asmedia.json",
			mutation: func(data []byte) []byte {
				return []byte(strings.Replace(string(data), `"device":`, `"rotation_rate": 5200,
  "device":`, 1))
			},
			want: nil,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := readCommandResult(t, test.file, test.code)
			result.Stdout = test.mutation(result.Stdout)

			sample, err := Decode(result, time.Now())
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}

			assertRotationRate(t, sample, test.want)
		})
	}
}

func assertRotationRate(t *testing.T, sample model.Sample, want *int) {
	t.Helper()

	data, err := json.Marshal(sample)
	if err != nil {
		t.Fatalf("marshal sample: %v", err)
	}

	var fields map[string]json.RawMessage

	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatalf("decode sample wire: %v", err)
	}

	value, exists := fields["rotationRate"]

	if !exists {
		t.Fatal("rotationRate missing from sample wire")
	}

	if want == nil {
		if string(value) != "null" {
			t.Errorf("rotationRate = %s, want null", value)
		}

		return
	}

	var got int

	if err := json.Unmarshal(value, &got); err != nil {
		t.Fatalf("decode rotationRate %s: %v", value, err)
	}

	if got != *want {
		t.Errorf("rotationRate = %d, want %d", got, *want)
	}
}

func protocolFixtures() []decodeFixture {
	return []decodeFixture{
		{name: "ATA HDD", file: "ata-hdd.json", protocol: model.ProtocolATA, health: model.HealthPassed, temperature: floatPointer(20), powerHours: stringPointer("884")},
		{name: "ATA SSD", file: "ata-ssd.json", protocol: model.ProtocolATA, health: model.HealthPassed, temperature: floatPointer(31), powerHours: stringPointer("18446744073709551615")},
		{name: "SCSI HDD", file: "scsi-usb-hdd.json", protocol: model.ProtocolSCSI, health: model.HealthUnknown},
		{name: "NVMe", file: "nvme-usb-asmedia.json", protocol: model.ProtocolNVMe, health: model.HealthPassed, temperature: floatPointer(23), powerHours: stringPointer("526")},
		{name: "SCSI NVMe bridge", file: "scsi-usb-nvme.json", exitCode: 4, protocol: model.ProtocolSCSI, health: model.HealthPassed},
		{name: "health failed", file: "health-failed.json", exitCode: 8, protocol: model.ProtocolATA, health: model.HealthFailed, temperature: floatPointer(30), powerHours: stringPointer("100")},
	}
}

func readCommandResult(t *testing.T, file string, exitCode int) model.CommandResult {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", file))
	if err != nil {
		t.Fatalf("read fixture %q: %v", file, err)
	}

	return model.CommandResult{Stdout: data, ExitCode: exitCode}
}

func TestDecodeProtocolMatrix(t *testing.T) {
	sampledAt := time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)

	for _, fixture := range protocolFixtures() {
		t.Run(fixture.name, func(t *testing.T) {
			sample, err := Decode(readCommandResult(t, fixture.file, fixture.exitCode), sampledAt)
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}

			if sample.Protocol != fixture.protocol || sample.Health != fixture.health {
				t.Fatalf("Decode() protocol/health = %q/%q, want %q/%q", sample.Protocol, sample.Health, fixture.protocol, fixture.health)
			}

			if sample.SampledAt != model.DateTime(sampledAt.Format(time.RFC3339Nano)) {
				t.Errorf("SampledAt = %q, want %q", sample.SampledAt, sampledAt.Format(time.RFC3339Nano))
			}

			if fixture.temperature == nil {
				if sample.TemperatureC != nil {
					t.Errorf("TemperatureC = %v, want null", *sample.TemperatureC)
				}
			} else if sample.TemperatureC == nil || *sample.TemperatureC != *fixture.temperature {
				t.Errorf("TemperatureC = %v, want %v", sample.TemperatureC, *fixture.temperature)
			}

			if fixture.powerHours == nil {
				if sample.PowerOnHours != nil || hasCounter(sample.Counters, "power_on_hours", "hours") {
					t.Errorf("missing power-on hours became zero/present: hours=%v counters=%v", sample.PowerOnHours, sample.Counters)
				}
			} else if sample.PowerOnHours == nil || *sample.PowerOnHours != *fixture.powerHours {
				t.Errorf("PowerOnHours = %v, want %q", sample.PowerOnHours, *fixture.powerHours)
			}

			if fixture.file == "ata-ssd.json" && (sample.Identity.Model == nil || string(*sample.Identity.Model) != "Synthetic ATA SSD") {
				t.Errorf("Identity.Model = %v, want synthetic SSD model", sample.Identity.Model)
			}

			if fixture.file == "ata-hdd.json" {
				for _, expected := range []struct{ name, value, unit string }{
					{"power_on_hours", "884", "hours"},
					{"reallocated_sector_count", "0", "sectors"},
					{"current_pending_sector_count", "0", "sectors"},
					{"offline_uncorrectable_sector_count", "0", "sectors"},
					{"udma_crc_error_count", "0", "errors"},
				} {
					if !hasCounterValue(sample.Counters, expected.name, expected.value, expected.unit) {
						t.Errorf("counter %q = %+v, want value=%q unit=%q", expected.name, sample.Counters, expected.value, expected.unit)
					}
				}
			}

			if fixture.file == "nvme-usb-asmedia.json" {
				for _, expected := range []struct{ name, value, unit string }{
					{"power_on_hours", "526", "hours"},
					{"data_units_read", "12364754", "data-units"},
					{"data_units_written", "11802817", "data-units"},
					{"media_errors", "0", "errors"},
					{"unsafe_shutdowns", "65", "events"},
					{"critical_warning", "0", "bitmask"},
					{"available_spare", "100", "percent"},
					{"percentage_used", "0", "percent"},
				} {
					if !hasCounterValue(sample.Counters, expected.name, expected.value, expected.unit) {
						t.Errorf("counter %q = %+v, want value=%q unit=%q", expected.name, sample.Counters, expected.value, expected.unit)
					}
				}
			}

			if len(sample.Counters) > model.MaxSampleCounters {
				t.Errorf("counter count = %d, max is %d", len(sample.Counters), model.MaxSampleCounters)
			}
		})
	}
}

func TestDecodeProtocolMatrixRejectsInvalidOrImplausibleOutput(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		file     string
		exitCode int
		stdout   string
	}{
		{name: "unknown shape", file: "invalid.json"},
		{name: "empty smartctl envelope", stdout: `{"smartctl":{},"device":{}}`},
		{name: "known protocol without read evidence", stdout: `{"smartctl":{},"device":{"protocol":"ATA"}}`},
		{name: "unknown NVMe log fields without read evidence", stdout: `{"smartctl":{},"device":{"protocol":"NVMe"},"nvme_smart_health_information_log":{"vendor_extension":1}}`},
		{name: "standby output", file: "standby.json", exitCode: 3},
		{name: "wrong bridge output", file: "wrong-bridge.json", exitCode: 8},
		{name: "fatal exit bit zero", file: "ata-ssd.json", exitCode: 1},
		{name: "fatal exit bit one", file: "ata-ssd.json", exitCode: 2},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			var result model.CommandResult

			if fixture.stdout != "" {
				result = model.CommandResult{Stdout: []byte(fixture.stdout), ExitCode: fixture.exitCode}
			} else {
				result = readCommandResult(t, fixture.file, fixture.exitCode)
			}

			sample, err := Decode(result, time.Now())
			if err == nil || sample.SchemaVersion != 0 || sample.Health != "" || sample.Assessment.Level != "" {
				t.Fatalf("Decode() = %+v, %v; want no sample and invalid-output", sample, err)
			}
		})
	}

	result := readCommandResult(t, "ata-ssd.json", 8)
	result.Failure = model.FailureTimeout

	if sample, err := Decode(result, time.Now()); err == nil {
		t.Fatalf("Decode() with runner failure = %+v, nil; want failure", sample)
	}
}

func TestDecodeRejectsPlausibilityViolations(t *testing.T) {
	baseline := `{"smartctl":{"version":[7,5]},"device":{"protocol":"NVMe"},"model_name":"Model","serial_number":"SERIAL","firmware_version":"1.0","smart_status":{"passed":true},"temperature":{"current":20},"nvme_smart_health_information_log":{"critical_warning":0,"temperature":20,"available_spare":99,"available_spare_threshold":10,"percentage_used":0,"data_units_read":0}}`
	cases := []struct {
		name               string
		file               string
		from               string
		to                 string
		wantError          bool
		wantTemperature    *float64
		wantCounterName    string
		wantCounterValue   string
		wantCounterUnit    string
		wantMetricsOmitted bool
	}{
		{name: "temperature below range", from: `"current":20`, to: `"current":-41`, wantError: true},
		{name: "temperature above range", from: `"current":20`, to: `"current":151`, wantError: true},
		{name: "temperature lower boundary", from: `"current":20`, to: `"current":-40`, wantTemperature: floatPointer(-40)},
		{name: "temperature upper boundary", from: `"current":20`, to: `"current":150`, wantTemperature: floatPointer(150)},
		{name: "NVMe critical warning high bits", from: `"critical_warning":0`, to: `"critical_warning":64`, wantError: true},
		{name: "NVMe critical warning maximum", from: `"critical_warning":0`, to: `"critical_warning":63`, wantCounterName: "critical_warning", wantCounterValue: "63", wantCounterUnit: "bitmask"},
		{name: "NVMe spare above one hundred", from: `"available_spare":99`, to: `"available_spare":101`, wantError: true},
		{name: "NVMe spare maximum", from: `"available_spare":99`, to: `"available_spare":100`, wantCounterName: "available_spare", wantCounterValue: "100", wantCounterUnit: "percent"},
		{name: "NVMe threshold above one hundred", from: `"available_spare_threshold":10`, to: `"available_spare_threshold":101`, wantError: true},
		{name: "NVMe counter full uint128 stays exact", from: `"data_units_read":0`, to: `"data_units_read":340282366920938463463374607431768211455`, wantCounterName: "data_units_read", wantCounterValue: "340282366920938463463374607431768211455", wantCounterUnit: "data-units"},
		{name: "40-digit metrics are omitted", from: `"data_units_read":0`, to: `"data_units_read":1`, wantMetricsOmitted: true},
		{name: "ATA temperature zero stays zero", file: "ata-hdd.json", from: `"current": 20`, to: `"current": 0`, wantTemperature: floatPointer(0)},
		{name: "non-ASCII model", from: `"model_name":"Model"`, to: `"model_name":"Model\u0001"`, wantError: true},
		{name: "non-ASCII serial", from: `"serial_number":"SERIAL"`, to: `"serial_number":"SERIAL\u00e9"`, wantError: true},
		{name: "non-ASCII firmware", from: `"firmware_version":"1.0"`, to: `"firmware_version":"1.0\u007f"`, wantError: true},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			input := baseline

			if test.file != "" {
				input = string(readCommandResult(t, test.file, 0).Stdout)
			}

			output := strings.Replace(input, test.from, test.to, 1)

			if output == input {
				t.Fatalf("test replacement did not change baseline: %q", test.from)
			}

			if test.wantMetricsOmitted {
				oversized := strings.Repeat("9", 40)
				output = strings.Replace(output, `"data_units_read":1`, `"data_units_read":`+oversized, 1)
				output = strings.Replace(output, `"smart_status":`, `"user_capacity":{"bytes":`+oversized+`},"power_on_time":{"hours":`+oversized+`},"smart_status":`, 1)
			}

			sample, err := Decode(model.CommandResult{Stdout: []byte(output), ExitCode: 8}, time.Now())

			if test.wantError {
				if err == nil {
					t.Fatal("Decode() succeeded, want invalid-output")
				}

				return
			}

			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}

			if test.wantTemperature != nil && (sample.TemperatureC == nil || *sample.TemperatureC != *test.wantTemperature) {
				t.Errorf("TemperatureC = %v, want %v", sample.TemperatureC, *test.wantTemperature)
			}

			if test.wantCounterName != "" && !hasCounterValue(sample.Counters, test.wantCounterName, test.wantCounterValue, test.wantCounterUnit) {
				t.Errorf("counter %q = %+v, want value=%q", test.wantCounterName, sample.Counters, test.wantCounterValue)
			}

			if test.wantMetricsOmitted && (sample.Identity.CapacityBytes != nil || sample.PowerOnHours != nil || hasCounter(sample.Counters, "data_units_read", "data-units")) {
				t.Errorf("40-digit metrics were retained: capacity=%v hours=%v counters=%+v", sample.Identity.CapacityBytes, sample.PowerOnHours, sample.Counters)
			}
		})
	}
}

func TestATA197And198RequireRecognizedNamesAndRotatingDisk(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "ata-ssd.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	knownNames := strings.Replace(string(data), "Vendor_Specific_197", "Current_Pending_Sector", 1)
	knownNames = strings.Replace(knownNames, "Vendor_Specific_198", "Offline_Uncorrectable", 1)
	result := model.CommandResult{Stdout: []byte(knownNames), ExitCode: 0}
	sample, err := Decode(result, time.Now())
	if err != nil {
		t.Fatalf("Decode() SSD with known names: %v", err)
	}

	if hasCounter(sample.Counters, "current_pending_sector_count", "sectors") || hasCounter(sample.Counters, "offline_uncorrectable_sector_count", "sectors") {
		t.Fatalf("non-rotating SSD produced HDD counters: %+v", sample.Counters)
	}

	rotating := strings.Replace(knownNames, `"rotation_rate": 0`, `"rotation_rate": 7200`, 1)
	sample, err = Decode(model.CommandResult{Stdout: []byte(rotating), ExitCode: 0}, time.Now())
	if err != nil {
		t.Fatalf("Decode() rotating disk with known names: %v", err)
	}

	if !hasCounter(sample.Counters, "current_pending_sector_count", "sectors") || !hasCounter(sample.Counters, "offline_uncorrectable_sector_count", "sectors") {
		t.Fatalf("rotating disk omitted recognized HDD counters: %+v", sample.Counters)
	}
}

func TestAssessmentV1(t *testing.T) {
	tests := []struct {
		name         string
		file         string
		level        model.Level
		reasons      []model.Reason
		mutate       func(*model.Sample)
		wantCounters []model.Counter
	}{
		{name: "passed without reasons", file: "ata-ssd.json", level: model.LevelNormal, reasons: []model.Reason{model.ReasonNoApplicableWarning}},
		{name: "unknown health", file: "scsi-usb-hdd.json", level: model.LevelUnknown, reasons: []model.Reason{model.ReasonNoHealthData}},
		{
			name:    "failed health and current threshold",
			file:    "health-failed.json",
			level:   model.LevelCritical,
			reasons: []model.Reason{model.ReasonSmartHealthFailed, model.ReasonATACurrentThresholdFailure, model.ReasonATAPendingSectors},
		},
		{
			name:    "NVMe critical warning",
			file:    "nvme-usb-asmedia.json",
			level:   model.LevelWarning,
			reasons: []model.Reason{model.ReasonNVMeCriticalWarning},
			mutate:  func(sample *model.Sample) { setCounter(sample, "critical_warning", "1") },
		},
		{
			name:    "failed health keeps NVMe warning critical",
			file:    "nvme-usb-asmedia.json",
			level:   model.LevelCritical,
			reasons: []model.Reason{model.ReasonSmartHealthFailed, model.ReasonNVMeCriticalWarning},
			mutate: func(sample *model.Sample) {
				sample.Health = model.HealthFailed

				setCounter(sample, "critical_warning", "1")
			},
		},
		{
			name:    "NVMe spare below threshold",
			file:    "nvme-usb-asmedia.json",
			level:   model.LevelWarning,
			reasons: []model.Reason{model.ReasonNVMeSpareBelowThreshold},
			mutate:  func(sample *model.Sample) { setCounter(sample, "available_spare", "9") },
		},
		{
			name:    "NVMe percentage used",
			file:    "nvme-usb-asmedia.json",
			level:   model.LevelWarning,
			reasons: []model.Reason{model.ReasonNVMePercentageUsed},
			mutate:  func(sample *model.Sample) { setCounter(sample, "percentage_used", "100") },
		},
		{
			name:    "ATA pending sectors",
			file:    "health-failed.json",
			level:   model.LevelWarning,
			reasons: []model.Reason{model.ReasonATAPendingSectors},
			mutate: func(sample *model.Sample) {
				sample.Health = model.HealthPassed

				for index := range sample.Attributes {
					sample.Attributes[index].WhenFailed = ""
				}
			},
		},
		{
			name:    "growth counters do not warn",
			file:    "ata-hdd.json",
			level:   model.LevelNormal,
			reasons: []model.Reason{model.ReasonNoApplicableWarning},
			wantCounters: []model.Counter{
				{Name: "reallocated_sector_count", Value: "8", Unit: "sectors"},
				{Name: "udma_crc_error_count", Value: "3", Unit: "errors"},
			},
			mutate: func(sample *model.Sample) {
				setCounter(sample, "reallocated_sector_count", "8")
				setCounter(sample, "udma_crc_error_count", "3")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sample, err := Decode(readCommandResult(t, test.file, 0), time.Now())
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}

			if test.mutate != nil {
				test.mutate(&sample)
			}

			for _, expected := range test.wantCounters {
				if !hasCounterValue(sample.Counters, string(expected.Name), expected.Value, string(expected.Unit)) {
					t.Fatalf("counter %q = %+v, want value=%q unit=%q", expected.Name, sample.Counters, expected.Value, expected.Unit)
				}
			}

			assessment := Assess(sample)

			if assessment.Level != test.level || !sameReasons(assessment.Reasons, test.reasons) || assessment.RulesVersion != 1 {
				t.Fatalf("Assess() = %+v, want level=%q reasons=%v rulesVersion=1", assessment, test.level, test.reasons)
			}

			if test.file == "ata-ssd.json" && (hasCounter(sample.Counters, "current_pending_sector_count", "sectors") || hasCounter(sample.Counters, "offline_uncorrectable_sector_count", "sectors")) {
				t.Error("SSD vendor-specific IDs 197/198 became known counters")
			}
		})
	}
}

func TestAssessmentV1HistoricalThresholdFailureIsNotCurrent(t *testing.T) {
	sample, err := Decode(readCommandResult(t, "ata-hdd.json", 0), time.Now())
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	sample.Health = model.HealthPassed
	sample.Attributes[0].WhenFailed = "past"

	assessment := Assess(sample)

	if assessment.Level != model.LevelNormal || hasReason(assessment.Reasons, model.ReasonATACurrentThresholdFailure) {
		t.Fatalf("historical threshold status assessment = %+v, want normal without current-failure reason", assessment)
	}
}

func hasCounter(counters []model.Counter, name, unit string) bool {
	for _, counter := range counters {
		if string(counter.Name) == name && string(counter.Unit) == unit {
			return true
		}
	}

	return false
}

func hasCounterValue(counters []model.Counter, name, value, unit string) bool {
	for _, counter := range counters {
		if string(counter.Name) == name && counter.Value == value && string(counter.Unit) == unit {
			return true
		}
	}

	return false
}

func setCounter(sample *model.Sample, name, value string) {
	for index := range sample.Counters {
		if string(sample.Counters[index].Name) == name {
			sample.Counters[index].Value = value

			return
		}
	}
}

func hasReason(reasons []model.Reason, want model.Reason) bool {
	for _, reason := range reasons {
		if reason == want {
			return true
		}
	}

	return false
}

func sameReasons(got, want []model.Reason) bool {
	if len(got) != len(want) {
		return false
	}

	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}

	return true
}
