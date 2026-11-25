package model

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWireGoldens(t *testing.T) {
	for _, golden := range wireGoldens() {
		t.Run(golden.name, func(t *testing.T) {
			got, err := json.Marshal(golden.value)
			if err != nil {
				t.Fatalf("marshal wire value: %v", err)
			}

			want, err := os.ReadFile(filepath.Join("..", "..", "testdata", "wire", golden.name+".golden.json"))
			if err != nil {
				t.Fatalf("read golden: %v", err)
			}

			if !sameJSON(got, want) {
				t.Errorf("wire JSON differs from golden\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

func TestOperationResultUnmarshalsTaggedVariants(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "wire", "operation.golden.json"))
	if err != nil {
		t.Fatal(err)
	}

	var rawOperations []json.RawMessage

	if err := json.Unmarshal(data, &rawOperations); err != nil {
		t.Fatal(err)
	}

	var discoverResults int
	var refreshResults int

	for _, rawOperation := range rawOperations {
		var operation Operation

		if err := json.Unmarshal(rawOperation, &operation); err != nil {
			t.Fatalf("decode operation: %v", err)
		}

		switch operation.Result.(type) {
		case DiscoverResult:
			discoverResults++
		case RefreshResult:
			refreshResults++
		}
	}

	if discoverResults != 1 || refreshResults != 1 {
		t.Fatalf("decoded tagged results: discover=%d refresh=%d", discoverResults, refreshResults)
	}
}

func TestSettingsRequestGoldenDecodes(t *testing.T) {
	want, ok := wireGolden("settings")

	if !ok {
		t.Fatal("settings golden value missing")
	}

	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "wire", "settings.golden.json"))
	if err != nil {
		t.Fatal(err)
	}

	var got SettingsRequest

	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode settings request: %v", err)
	}

	if !reflect.DeepEqual(got, want.value) {
		t.Fatalf("decoded settings request differs\n got: %#v\nwant: %#v", got, want.value)
	}
}

type wireGoldenCase struct {
	name  string
	value any
}

func wireGolden(name string) (wireGoldenCase, bool) {
	for _, golden := range wireGoldens() {
		if golden.name == name {
			return golden, true
		}
	}

	return wireGoldenCase{}, false
}

func wireGoldens() []wireGoldenCase {
	return []wireGoldenCase{
		{name: "snapshot", value: snapshotGolden()},
		{name: "operation", value: operationGolden()},
		{name: "history", value: historyGolden()},
		{name: "config", value: configGolden()},
		{name: "settings", value: settingsGolden()},
		{name: "device-type", value: DeviceTypeResponse{SchemaVersion: 1, DeviceID: "dev-a", DeviceType: "sntasmedia", DeviceTypeSource: DeviceTypeSourceUser}},
		{name: "error", value: APIError{SchemaVersion: 1, Error: ErrorDetail{Code: "revision-conflict"}}},
	}
}

func snapshotGolden() Snapshot {
	return Snapshot{
		SchemaVersion: 1,
		ServerNow:     "2026-11-24T12:00:00Z",
		ClockStatus:   ClockValid,
		Devices: []Device{{
			DeviceID:         "dev-a",
			Path:             "/dev/sda",
			DeviceType:       "sat",
			DeviceTypeSource: DeviceTypeSourceScan,
			USBBridge:        text("1058:25a0"),
			Binding:          BindingValidated,
			Sample: &Sample{
				SchemaVersion: 1,
				DeviceID:      "dev-a",
				SampledAt:     "2026-11-24T11:59:57Z",
				Protocol:      ProtocolATA,
				Identity: Identity{
					Reliable:      true,
					Model:         text("ACME HDD 2TB"),
					Serial:        nil,
					WWN:           text("0x5001b448b9a1c001"),
					CapacityBytes: stringValue("2000398934016"),
				},
				TemperatureC: nil,
				PowerOnHours: stringValue("18446744073709551615"),
				RotationRate: intValue(5200),
				Health:       HealthPassed,
				Assessment: Assessment{
					Level:        LevelNormal,
					Reasons:      []Reason{ReasonNoApplicableWarning},
					RulesVersion: 1,
				},
				Counters:     []Counter{{Name: "power_on_hours", Value: "18446744073709551615", Unit: "hours"}},
				Capabilities: Capabilities{Attributes: true, Temperature: true, StandbyOnlyValidated: false},
				Attributes: []Attribute{{
					ID:         intValue(9),
					Name:       "Power_On_Hours",
					Raw:        nil,
					Normalized: floatValue(100),
					Threshold:  nil,
				}},
			},
			Collection: Collection{Status: CollectionOK, ExitCode: intValue(0)},
			Freshness: Freshness{
				LastAttemptAt: datetime("2026-11-24T11:59:57Z"),
				LastSuccessAt: datetime("2026-11-24T11:59:57Z"),
				Stale:         false,
			},
			Polling:   nil,
			Truncated: false,
		}},
		Diagnostics: Diagnostics{
			CheckedAt: "2026-11-24T11:59:58Z",
			EUID:      0,
			EGID:      0,
			Groups:    []uint32{0, 6},
			Utility: UtilityDiagnostic{
				Path:      text("/opt/sbin/smartctl"),
				Version:   text("smartctl 7.5"),
				Available: true,
			},
			Smartd: SmartdDiagnostic{
				Status:    SmartdNotDetected,
				CheckedAt: "2026-11-24T11:59:58Z",
				Reason:    nil,
			},
			Reasons: []Text{},
		},
		Config:                nil,
		Persistence:           nil,
		Truncated:             false,
		DisconnectedTruncated: false,
	}
}

func operationGolden() []Operation {
	return []Operation{
		{
			SchemaVersion: 1,
			ID:            "op-queued",
			Kind:          OperationDiscover,
			DeviceID:      nil,
			Status:        OperationQueued,
			CreatedAt:     "2026-11-24T11:00:00Z",
			CompletedAt:   nil,
			Result:        nil,
			Error:         nil,
		},
		{
			SchemaVersion: 1,
			ID:            "op-running",
			Kind:          OperationRefresh,
			DeviceID:      id("dev-a"),
			Status:        OperationRunning,
			CreatedAt:     "2026-11-24T11:01:00Z",
			CompletedAt:   nil,
			Result:        nil,
			Error:         nil,
		},
		{
			SchemaVersion: 1,
			ID:            "op-discover-ok",
			Kind:          OperationDiscover,
			DeviceID:      nil,
			Status:        OperationSucceeded,
			CreatedAt:     "2026-11-24T11:02:00Z",
			CompletedAt:   datetime("2026-11-24T11:02:03Z"),
			Result:        DiscoverResult{Kind: OperationDiscover, DeviceIDs: []ID{"dev-a"}, Truncated: false, ExitCode: 0},
			Error:         nil,
		},
		{
			SchemaVersion: 1,
			ID:            "op-refresh-ok",
			Kind:          OperationRefresh,
			DeviceID:      id("dev-a"),
			Status:        OperationSucceeded,
			CreatedAt:     "2026-11-24T11:03:00Z",
			CompletedAt:   datetime("2026-11-24T11:03:04Z"),
			Result:        RefreshResult{Kind: OperationRefresh, DeviceID: "dev-a", ExitCode: 0, SampleAccepted: true},
			Error:         nil,
		},
		{
			SchemaVersion: 1,
			ID:            "op-failed",
			Kind:          OperationRefresh,
			DeviceID:      id("dev-a"),
			Status:        OperationFailed,
			CreatedAt:     "2026-11-24T11:04:00Z",
			CompletedAt:   datetime("2026-11-24T11:04:10Z"),
			Result:        nil,
			Error:         &ErrorDetail{Code: "timeout"},
		},
		{
			SchemaVersion: 1,
			ID:            "op-cancelled",
			Kind:          OperationDiscover,
			DeviceID:      nil,
			Status:        OperationCancelled,
			CreatedAt:     "2026-11-24T11:05:00Z",
			CompletedAt:   datetime("2026-11-24T11:05:01Z"),
			Result:        nil,
			Error:         &ErrorDetail{Code: "service-stopping"},
		},
	}
}

func historyGolden() HistoryResponse {
	return HistoryResponse{
		SchemaVersion: 1,
		DeviceID:      "dev-a",
		ServerNow:     "2026-11-24T12:00:00Z",
		ClockStatus:   ClockValid,
		From:          "2026-11-23T12:00:00Z",
		To:            "2026-11-24T12:00:00Z",
		Buckets: []Bucket{
			{
				HourStart:     "2026-11-24T08:00:00Z",
				FirstSampleAt: "2026-11-24T08:10:00Z",
				LastSampleAt:  "2026-11-24T08:50:00Z",
				SampleCount:   2,
				TemperatureC:  &TemperatureSummary{Min: 41, Max: 43, Last: 43},
				Counters:      []HistoryCounter{{Name: "power_on_hours", Value: "120", Unit: "hours"}},
				Assessment:    Assessment{Level: LevelNormal, Reasons: []Reason{ReasonNoApplicableWarning}, RulesVersion: 1},
			},
			{
				HourStart:     "2026-11-24T10:00:00Z",
				FirstSampleAt: "2026-11-24T10:15:00Z",
				LastSampleAt:  "2026-11-24T10:15:00Z",
				SampleCount:   1,
				TemperatureC:  nil,
				Counters:      []HistoryCounter{},
				Assessment:    Assessment{Level: LevelUnknown, Reasons: []Reason{ReasonNoHealthData}, RulesVersion: 1},
			},
		},
		Gaps: []TimeRange{
			{From: "2026-11-23T12:00:00Z", To: "2026-11-24T08:00:00Z"},
			{From: "2026-11-24T09:00:00Z", To: "2026-11-24T10:00:00Z"},
			{From: "2026-11-24T11:00:00Z", To: "2026-11-24T12:00:00Z"},
		},
		Coverage:  Coverage{SampleCount: 3, CoveredSeconds: 7200, WindowSeconds: 86400},
		Truncated: false,
		Reason:    nil,
	}
}

func configGolden() Config {
	return Config{
		SchemaVersion:     1,
		Revision:          "1",
		PersistentHistory: true,
		Devices: []DeviceConfig{
			{DeviceID: "dev-a", Mode: ModeOff},
			{DeviceID: "dev-b", Mode: ModeAllowWake},
		},
	}
}

func settingsGolden() SettingsRequest {
	return SettingsRequest{
		ExpectedRevision:  "0",
		PersistentHistory: true,
		Devices: []SettingsDevice{
			{DeviceID: "dev-a", Mode: ModeOff},
			{DeviceID: "dev-b", Mode: ModeAllowWake, AcknowledgeWake: boolValue(true)},
		},
	}
}

func sameJSON(left []byte, right []byte) bool {
	var leftValue any
	var rightValue any
	leftDecoder := json.NewDecoder(bytes.NewReader(left))

	leftDecoder.UseNumber()

	rightDecoder := json.NewDecoder(bytes.NewReader(right))

	rightDecoder.UseNumber()

	if leftDecoder.Decode(&leftValue) != nil || rightDecoder.Decode(&rightValue) != nil {
		return false
	}

	return reflect.DeepEqual(leftValue, rightValue)
}

func text(value string) *Text {
	result := Text(value)

	return &result
}

func stringValue(value string) *string {
	return &value
}

func intValue(value int) *int {
	return &value
}

func floatValue(value float64) *float64 {
	return &value
}

func id(value string) *ID {
	result := ID(value)

	return &result
}

func datetime(value string) *DateTime {
	result := DateTime(value)

	return &result
}

func boolValue(value bool) *bool {
	return &value
}
