package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"smart-page/internal/devices"
	"smart-page/internal/model"
)

func TestSnapshotBudget(t *testing.T) {
	tests := []struct {
		name                string
		deviceCount         int
		attributesPerDevice int
		clipDisplayText     bool
	}{
		{
			name:                "maximum snapshot",
			deviceCount:         model.MaxSnapshotDevices,
			attributesPerDevice: model.MaxSampleAttributes,
		},
		{
			name:                "attribute count cap",
			deviceCount:         1,
			attributesPerDevice: model.MaxSampleAttributes + 1,
			clipDisplayText:     true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			testSnapshotBudget(t, test.deviceCount, test.attributesPerDevice, test.clipDisplayText)
		})
	}
}

func testSnapshotBudget(t *testing.T, deviceCount int, attributesPerDevice int, clipDisplayText bool) {
	t.Helper()

	snapshot := worstCaseSnapshot(deviceCount, attributesPerDevice, clipDisplayText)
	before, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal input snapshot: %v", err)
	}

	body, err := EncodeSnapshot(snapshot)
	if err != nil {
		t.Fatalf("encode snapshot: %v", err)
	}

	if len(body) > model.MaxSnapshotBytes {
		t.Fatalf("snapshot size = %d, exceeds %d bytes", len(body), model.MaxSnapshotBytes)
	}

	var got model.Snapshot

	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode encoded snapshot: %v", err)
	}

	if len(got.Devices) != deviceCount {
		t.Fatalf("device count = %d, want %d", len(got.Devices), deviceCount)
	}

	device := got.Devices[0]

	if device.Sample == nil {
		t.Fatal("device 0 lost sample core")
	}

	sample := device.Sample

	if len(sample.Counters) != model.MaxSampleCounters || !sample.Identity.Reliable || sample.Identity.Model == nil || sample.Health != model.HealthFailed || sample.Assessment.Level != model.LevelCritical {
		t.Error("device 0 lost core fields")
	}

	if device.Collection.Status != model.CollectionOK || device.Freshness.Stale {
		t.Errorf("device 0 collection/freshness = %q/%+v, want ok and fresh", device.Collection.Status, device.Freshness)
	}

	if len(sample.Assessment.Reasons) != len(allAssessmentReasons()) {
		t.Error("device 0 lost assessment reasons")
	} else {
		for reasonIndex, reason := range allAssessmentReasons() {
			if sample.Assessment.Reasons[reasonIndex] != reason {
				t.Errorf("device 0 reason %d = %q, want %q", reasonIndex, sample.Assessment.Reasons[reasonIndex], reason)
			}
		}
	}

	retainedAttributes := len(sample.Attributes)

	if retainedAttributes >= deviceCount*attributesPerDevice || !got.Truncated {
		t.Fatalf("retained=%d snapshot.truncated=%t; want attribute cut and snapshot truncation", retainedAttributes, got.Truncated)
	}

	for index, device := range got.Devices {
		if !clipDisplayText && (len(device.Sample.Attributes) < attributesPerDevice) != device.Truncated {
			t.Errorf("device %d truncated=%t with %d/%d attributes", index, device.Truncated, len(device.Sample.Attributes), attributesPerDevice)
		}
	}

	if got.Diagnostics.Groups == nil || len(got.Diagnostics.Groups) > model.MaxDiagnosticGroups || got.Diagnostics.Reasons == nil || len(got.Diagnostics.Reasons) > model.MaxDiagnosticReasons {
		t.Fatal("diagnostic groups or reasons were lost or exceeded their limits")
	}

	if got.Devices[0].Sample.Identity.CapacityBytes == nil || *got.Devices[0].Sample.Identity.CapacityBytes != strings.Repeat("9", 39) || got.Devices[0].Sample.PowerOnHours == nil || *got.Devices[0].Sample.PowerOnHours != strings.Repeat("9", 39) || !strings.Contains(string(body), `"value":"`+strings.Repeat("9", 39)+`"`) {
		t.Fatal("encoder changed numeric metric values")
	}

	if clipDisplayText && (len(got.Devices[0].Path) != 255 || len(got.Devices[0].Sample.Attributes[0].Name) != 255 || got.Diagnostics.Utility.Path == nil || len(*got.Diagnostics.Utility.Path) != 255 || len(got.Diagnostics.Reasons[0]) != 255) {
		t.Fatal("display text was not clipped at a UTF-8 boundary")
	}

	after, err := json.Marshal(snapshot)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("encoder mutated cached snapshot input")
	}
}

func TestSnapshotDisconnectedVisibility(t *testing.T) {
	tests := []struct {
		name                     string
		currentCount             int
		wantDeviceCount          int
		wantDisconnectedCut      bool
		wantRetainedDisconnected bool
	}{
		{
			name:                "current devices fill snapshot",
			currentCount:        model.MaxCurrentDevices,
			wantDeviceCount:     model.MaxSnapshotDevices,
			wantDisconnectedCut: true,
		},
		{
			name:                     "retained disconnected follows current",
			currentCount:             1,
			wantDeviceCount:          2,
			wantRetainedDisconnected: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := snapshotTestRegistry()

			if err := registry.Discover(snapshotScan("/dev/old"), emptySnapshotScan()); err != nil {
				t.Fatalf("discover old device: %v", err)
			}

			oldIDs, _ := registry.CurrentIDs()

			if len(oldIDs) != 1 {
				t.Fatalf("old device count = %d, want 1", len(oldIDs))
			}

			sample := model.Sample{
				SampledAt: "2026-11-24T12:00:00Z",
				Identity: model.Identity{
					Model:  snapshotText("retained model"),
					Serial: snapshotText("retained serial"),
				},
				Health: model.HealthPassed,
				Assessment: model.Assessment{
					Level:   model.LevelNormal,
					Reasons: []model.Reason{model.ReasonNoApplicableWarning},
				},
				Counters:     []model.Counter{},
				Attributes:   []model.Attribute{},
				Capabilities: model.Capabilities{},
			}

			if _, err := registry.Accept(string(oldIDs[0]), sample, 0); err != nil {
				t.Fatalf("accept old sample: %v", err)
			}

			currentPaths := make([]string, test.currentCount)

			for index := range currentPaths {
				currentPaths[index] = fmt.Sprintf("/dev/current-%02d", index)
			}

			if err := registry.Discover(snapshotScan(currentPaths...), emptySnapshotScan()); err != nil {
				t.Fatalf("discover current devices: %v", err)
			}

			visible, truncated, disconnectedTruncated := registry.VisibleDevices()
			snapshot := model.Snapshot{
				SchemaVersion:         1,
				ServerNow:             "2026-11-24T12:01:00Z",
				ClockStatus:           model.ClockValid,
				Devices:               visible,
				Diagnostics:           model.Diagnostics{Groups: []uint32{}, Reasons: []model.Text{}},
				Truncated:             truncated,
				DisconnectedTruncated: disconnectedTruncated,
			}

			body, err := EncodeSnapshot(snapshot)
			if err != nil {
				t.Fatalf("encode visible devices: %v", err)
			}

			var got model.Snapshot

			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatalf("decode visible snapshot: %v", err)
			}

			if len(got.Devices) != test.wantDeviceCount {
				t.Fatalf("device count = %d, want %d", len(got.Devices), test.wantDeviceCount)
			}

			if got.DisconnectedTruncated != test.wantDisconnectedCut {
				t.Fatalf("disconnectedTruncated = %t, want %t", got.DisconnectedTruncated, test.wantDisconnectedCut)
			}

			if test.wantDisconnectedCut && !got.Truncated {
				t.Fatal("snapshot.truncated = false when disconnected records were cut")
			}

			if test.wantRetainedDisconnected {
				current := got.Devices[0]
				disconnected := got.Devices[1]

				if current.Binding == model.BindingDisconnected || disconnected.Binding != model.BindingDisconnected {
					t.Fatalf("device order = %q, %q; current must precede disconnected", current.Binding, disconnected.Binding)
				}

				if disconnected.Sample == nil || disconnected.Sample.Identity.Model == nil || *disconnected.Sample.Identity.Model != "retained model" {
					t.Fatalf("disconnected last sample = %+v, want retained model sample", disconnected.Sample)
				}

				if !disconnected.Freshness.Stale || disconnected.Polling != nil {
					t.Fatalf("disconnected freshness/polling = %+v / %+v, want stale and null", disconnected.Freshness, disconnected.Polling)
				}
			}
		})
	}
}

func TestSnapshotFairAttributeBudget(t *testing.T) {
	for _, test := range []struct{ name string }{{name: "escaped early attribute"}} {
		t.Run(test.name, func(t *testing.T) {
			devices, large := make([]model.Device, 4), strings.Repeat("<", 256)

			for deviceIndex := range devices {
				attributes := make([]model.Attribute, model.MaxSampleAttributes)

				for attributeIndex := range attributes {
					id := attributeIndex
					name, raw := "small", model.Text("1")

					if deviceIndex == 0 && attributeIndex == 0 {
						name = "first"
					} else if deviceIndex == 0 {
						name, raw = large, model.Text(large)
					}

					attributes[attributeIndex] = model.Attribute{ID: &id, Name: model.Text(name), Raw: &raw}
				}

				devices[deviceIndex] = model.Device{DeviceID: model.ID(fmt.Sprint(deviceIndex)), Sample: &model.Sample{Attributes: attributes}}
			}

			snapshot := model.Snapshot{Devices: devices, Diagnostics: model.Diagnostics{Groups: []uint32{}, Reasons: []model.Text{}}}
			body, err := EncodeSnapshot(snapshot)
			if err != nil {
				t.Fatalf("encode snapshot: %v", err)
			}

			if len(body) > model.MaxSnapshotBytes || !strings.Contains(string(body), `\u003c`) {
				t.Fatalf("body size=%d or escaped attribute missing", len(body))
			}

			var got model.Snapshot

			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatalf("decode snapshot: %v", err)
			}

			continued, firstDeviceAttributes := false, len(got.Devices[0].Sample.Attributes)

			for index, device := range got.Devices {
				retained := len(device.Sample.Attributes)

				if retained == 0 || device.Truncated != (retained < model.MaxSampleAttributes) {
					t.Errorf("device %d retained=%d truncated=%t", index, retained, device.Truncated)
				}

				if index > 0 && retained > firstDeviceAttributes {
					continued = true
				}

				for attributeIndex, attribute := range device.Sample.Attributes {
					if attribute.ID == nil || *attribute.ID != attributeIndex {
						t.Fatalf("device %d attribute order changed at %d", index, attributeIndex)
					}
				}
			}

			if !continued || !got.Truncated || got.DisconnectedTruncated {
				t.Fatalf("continued=%t truncated=%t disconnectedTruncated=%t", continued, got.Truncated, got.DisconnectedTruncated)
			}

			attributes := got.Devices[0].Sample.Attributes

			if len(attributes) < 2 || string(attributes[1].Name) != large || attributes[1].Raw == nil || string(*attributes[1].Raw) != large {
				t.Fatal("large escaped early attribute was not preserved")
			}
		})
	}
}

func worstCaseSnapshot(deviceCount int, attributesPerDevice int, clipDisplayText bool) model.Snapshot {
	longText := strings.Repeat("界", model.MaxDeviceStringBytes/3)
	displayText := longText

	if clipDisplayText {
		displayText += "界"
	}

	devices := make([]model.Device, 0, deviceCount)

	for deviceIndex := 0; deviceIndex < deviceCount; deviceIndex++ {
		counters := make([]model.Counter, model.MaxSampleCounters)

		for counterIndex := range counters {
			counters[counterIndex] = model.Counter{
				Name:  model.Text(fmt.Sprintf("counter-%02d", counterIndex)),
				Value: strings.Repeat("9", 39),
				Unit:  "units",
			}
		}

		attributes := make([]model.Attribute, attributesPerDevice)

		for attributeIndex := range attributes {
			id := attributeIndex % 256
			raw := model.Text(displayText)
			normalized := float64(attributeIndex)
			threshold := float64(attributeIndex + 1)
			attributes[attributeIndex] = model.Attribute{
				ID:         &id,
				Name:       model.Text(displayText),
				Raw:        &raw,
				Normalized: &normalized,
				Threshold:  &threshold,
			}
		}

		devices = append(devices, model.Device{
			DeviceID:         model.ID(fmt.Sprintf("device-%02d", deviceIndex)),
			Path:             model.Text(displayText),
			DeviceType:       model.Text(longText),
			DeviceTypeSource: model.DeviceTypeSourceScan,
			USBBridge:        snapshotText(longText),
			Binding:          model.BindingValidated,
			Sample: &model.Sample{
				SchemaVersion: 1,
				DeviceID:      model.ID(fmt.Sprintf("device-%02d", deviceIndex)),
				SampledAt:     "2026-11-24T12:00:00Z",
				Protocol:      model.ProtocolATA,
				Identity: model.Identity{
					Reliable:      true,
					Model:         snapshotText(longText),
					Serial:        snapshotText(longText),
					WWN:           snapshotText(longText),
					CapacityBytes: snapshotString(strings.Repeat("9", 39)),
				},
				TemperatureC: snapshotFloat(32),
				PowerOnHours: snapshotString(strings.Repeat("9", 39)),
				Health:       model.HealthFailed,
				Assessment: model.Assessment{
					Level:        model.LevelCritical,
					Reasons:      allAssessmentReasons(),
					RulesVersion: 1,
				},
				Counters:     counters,
				Capabilities: model.Capabilities{Attributes: true, Temperature: true},
				Attributes:   attributes,
			},
			Collection: model.Collection{Status: model.CollectionOK},
			Freshness:  model.Freshness{Stale: false},
			Truncated:  false,
		})
	}

	groups := make([]uint32, model.MaxDiagnosticGroups+8)

	for index := range groups {
		groups[index] = uint32(index)
	}

	return model.Snapshot{
		SchemaVersion: 1,
		ServerNow:     "2026-11-24T12:00:00Z",
		ClockStatus:   model.ClockValid,
		Devices:       devices,
		Diagnostics: model.Diagnostics{
			CheckedAt: "2026-11-24T12:00:00Z",
			Groups:    groups,
			Utility: model.UtilityDiagnostic{
				Path:      snapshotText(displayText),
				Version:   snapshotText(displayText),
				Available: true,
			},
			Smartd: model.SmartdDiagnostic{
				Status:    model.SmartdUnknown,
				CheckedAt: "2026-11-24T12:00:00Z",
				Reason:    snapshotText(displayText),
			},
			Reasons: makeLongDiagnosticReasons(model.MaxDiagnosticReasons+8, displayText),
		},
		Truncated: false,
	}
}

func makeLongDiagnosticReasons(count int, value string) []model.Text {
	reasons := make([]model.Text, count)

	for index := range reasons {
		reasons[index] = model.Text(value)
	}

	return reasons
}

func allAssessmentReasons() []model.Reason {
	return []model.Reason{
		model.ReasonSmartHealthFailed,
		model.ReasonATACurrentThresholdFailure,
		model.ReasonNVMeCriticalWarning,
		model.ReasonNVMeSpareBelowThreshold,
		model.ReasonNVMePercentageUsed,
		model.ReasonATAPendingSectors,
		model.ReasonATAUncorrectableSectors,
		model.ReasonNoHealthData,
		model.ReasonNoApplicableWarning,
	}
}

func snapshotTestRegistry() *devices.Registry {
	var sequence int
	newID := func() string {
		sequence++

		return fmt.Sprintf("device-%02d", sequence)
	}

	return devices.NewRegistry(snapshotTestOS{}, newID)
}

type snapshotTestOS struct{}

func (snapshotTestOS) Inspect(path string) (devices.Binding, error) {
	return devices.Binding{Path: path, Token: "binding-" + path}, nil
}

func snapshotScan(paths ...string) []byte {
	type scanDevice struct {
		Name string `json:"name"`
		Type string `json:"type"`
	}

	type scan struct {
		Devices []scanDevice `json:"devices"`
	}

	devices := make([]scanDevice, 0, len(paths))

	for _, path := range paths {
		devices = append(devices, scanDevice{Name: path, Type: "sat"})
	}

	data, _ := json.Marshal(scan{Devices: devices})

	return data
}

func emptySnapshotScan() []byte {
	return snapshotScan()
}

func snapshotText(value string) *model.Text {
	text := model.Text(value)

	return &text
}

func snapshotString(value string) *string {
	return &value
}

func snapshotFloat(value float64) *float64 {
	return &value
}
