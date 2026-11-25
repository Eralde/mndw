package devices

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"smart-page/internal/model"
)

type fakeOS struct {
	bindings map[string]Binding
	paths    map[string]string
}

type generationBlockingOS struct {
	entered chan struct{}
	release chan struct{}
	blocked sync.Once
}

type generationChangingOS struct {
	registry       *Registry
	changePath     string
	changeDeviceID string
	changesLeft    int
}

func (operatingSystem *generationChangingOS) Inspect(path string) (Binding, error) {
	if path == operatingSystem.changePath && operatingSystem.changesLeft != 0 {
		if operatingSystem.changesLeft > 0 {
			operatingSystem.changesLeft--
		}

		if _, err := operatingSystem.registry.Accept(operatingSystem.changeDeviceID, model.Sample{}, 0); err != nil {
			return Binding{}, err
		}
	}

	return Binding{Path: path, Token: "token:" + path}, nil
}

func (operatingSystem *generationBlockingOS) Inspect(path string) (Binding, error) {
	if path == "/dev/sdb" {
		operatingSystem.blocked.Do(func() {
			operatingSystem.entered <- struct{}{}

			<-operatingSystem.release
		})
	}

	return Binding{Path: path, Token: "token:" + path}, nil
}

func (fake *fakeOS) Inspect(path string) (Binding, error) {
	if binding, exists := fake.bindings[path]; exists {
		return binding, nil
	}

	return Binding{}, errors.New("not a whole block device")
}

func registryWithPaths(paths ...string) (*Registry, *fakeOS) {
	fake := &fakeOS{bindings: make(map[string]Binding), paths: make(map[string]string)}
	sequence := 0
	registry := NewRegistry(fake, func() string {
		sequence++

		return "device-" + string(rune('a'+sequence-1))
	})

	for _, path := range paths {
		fake.bindings[path] = Binding{Path: path, Token: "token:" + path}
		fake.paths[path] = path
	}

	return registry, fake
}

func TestDiscoveryMergesScansWithPlainTypePrecedence(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda", "/dev/nvme0n1")

	plain, err := os.ReadFile(filepath.Join("..", "..", "testdata", "scan-plain.json"))
	if err != nil {
		t.Fatal(err)
	}

	scsi, err := os.ReadFile(filepath.Join("..", "..", "testdata", "scan-scsi.json"))
	if err != nil {
		t.Fatal(err)
	}

	if err := registry.Discover(plain, scsi); err != nil {
		t.Fatalf("Discover() error = %v", err)
	}

	devices := registry.Devices()

	if len(devices) != 1 || devices[0].Path != "/dev/sda" || devices[0].DeviceType != "scsi" {
		t.Fatalf("devices = %+v, want one /dev/sda scsi entry", devices)
	}

	plainOverride := []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`)

	if err := registry.Discover(plainOverride, scsi); err != nil {
		t.Fatalf("Discover() with overlapping scans: %v", err)
	}

	ids, _ := registry.CurrentIDs()

	if len(ids) != 1 {
		t.Fatalf("current IDs after type change = %v, want one current device", ids)
	}

	target, err := registry.Target(string(ids[0]))

	if err != nil || target.Type != "sat" {
		t.Fatalf("plain scan target = %+v, error = %v, want sat", target, err)
	}
}

func TestDiscoveryTreatsMissingDevicesAsEmpty(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda")

	if err := registry.Discover([]byte(`{"smartctl":{"version":[7,5]}}`), []byte(`{}`)); err != nil {
		t.Fatalf("missing devices key: %v", err)
	}

	if got := registry.Devices(); len(got) != 0 {
		t.Fatalf("missing devices key produced %d devices", len(got))
	}
}

func TestDiscoverRetriesAfterRegistryChanges(t *testing.T) {
	operatingSystem := &generationBlockingOS{
		entered: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	sequence := 0
	registry := NewRegistry(operatingSystem, func() string {
		sequence++

		return "device-" + string(rune('a'+sequence-1))
	})
	plainScan := []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`)

	if err := registry.Discover(plainScan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	ids, _ := registry.CurrentIDs()

	if len(ids) != 1 {
		t.Fatalf("seed current IDs = %v, want one device", ids)
	}

	var releaseOnce sync.Once
	releaseInspection := func() {
		releaseOnce.Do(func() {
			close(operatingSystem.release)
		})
	}

	t.Cleanup(releaseInspection)

	discoveryDone := make(chan error, 1)

	go func() {
		discoveryDone <- registry.Discover([]byte(`{"devices":[{"name":"/dev/sdb","type":"sat"}]}`), []byte(`{}`))
	}()

	select {
	case <-operatingSystem.entered:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("discovery did not enter blocked inspection")
	}

	if _, err := registry.Accept(string(ids[0]), model.Sample{}, 0); err != nil {
		t.Fatalf("Accept while discovery inspection is blocked: %v", err)
	}

	releaseInspection()

	select {
	case err := <-discoveryDone:
		if err != nil {
			t.Fatalf("Discover() after one concurrent registry change = %v, want success", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("discovery did not finish after inspection was released")
	}

	ids, _ = registry.CurrentIDs()
	devices := registry.Devices()

	if len(ids) != 1 || ids[0] != "device-b" || len(devices) != 2 {
		t.Fatalf("registry after retried discovery = IDs %v, devices %+v; want current device-b and retained device-a", ids, devices)
	}

	foundAcceptedDisconnected := false

	for _, device := range devices {
		if device.DeviceID == "device-a" && device.Sample != nil && device.Binding == model.BindingDisconnected {
			foundAcceptedDisconnected = true
		}
	}

	if !foundAcceptedDisconnected {
		t.Fatalf("registry after retried discovery = %+v; want accepted device-a retained as disconnected", devices)
	}
}

func TestTargetAndAcceptRetryInspectionAfterRegistryChanges(t *testing.T) {
	operatingSystem := &generationChangingOS{}
	sequence := 0
	registry := NewRegistry(operatingSystem, func() string {
		sequence++

		return "device-" + string(rune('a'+sequence-1))
	})
	operatingSystem.registry = registry
	scan := []byte(`{"devices":[{"name":"/dev/sda","type":"sat"},{"name":"/dev/sdb","type":"sat"}]}`)

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	ids, _ := registry.CurrentIDs()

	if len(ids) != 2 {
		t.Fatalf("seed current IDs = %v, want two devices", ids)
	}

	operatingSystem.changePath = "/dev/sda"
	operatingSystem.changeDeviceID = string(ids[1])
	operatingSystem.changesLeft = 1
	target, err := registry.Target(string(ids[0]))
	if err != nil || target.Path != "/dev/sda" {
		t.Fatalf("Target() after one registry change = %+v, error = %v, want success", target, err)
	}

	operatingSystem.changesLeft = 1
	accepted, err := registry.Accept(string(ids[0]), model.Sample{}, 0)
	if err != nil || accepted.DeviceID != ids[0] {
		t.Fatalf("Accept() after one registry change = %+v, error = %v, want success", accepted, err)
	}

	operatingSystem.changesLeft = -1

	if _, err := registry.Target(string(ids[0])); errorCode(err) != "busy" {
		t.Fatalf("Target() after repeated registry changes = %v, want busy", err)
	}

	operatingSystem.changesLeft = -1

	if _, err := registry.Accept(string(ids[0]), model.Sample{}, 0); !IsInspectionRace(err) || ErrorCode(err) != "" {
		t.Fatalf("Accept() after repeated registry changes = %v, want internal inspection-race error", err)
	}
}

func TestDiscoveryCapsCurrentDevices(t *testing.T) {
	paths := make([]string, model.MaxCurrentDevices+2)
	entries := make([]map[string]string, 0, len(paths))

	for index := range paths {
		paths[index] = "/dev/sd" + string(rune('a'+index))
		entries = append(entries, map[string]string{"name": paths[index], "type": "scsi"})
	}

	registry, _ := registryWithPaths(paths...)

	scan, err := json.Marshal(map[string]any{"devices": entries})
	if err != nil {
		t.Fatal(err)
	}

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatalf("Discover() capped list: %v", err)
	}

	devices := registry.Devices()
	ids, truncated := registry.CurrentIDs()

	if len(devices) != model.MaxCurrentDevices || len(ids) != model.MaxCurrentDevices || !truncated {
		t.Fatalf("visible=%d ids=%d truncated=%v, want %d, %d, true", len(devices), len(ids), truncated, model.MaxCurrentDevices, model.MaxCurrentDevices)
	}
}

func TestDiscoveryRejectsMalformedScanDocuments(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda")

	for _, scan := range [][]byte{[]byte("null"), []byte(`{"devices":null}`), []byte(`{"devices":"/dev/sda"}`)} {
		if err := registry.Discover(scan, []byte(`{}`)); ErrorCode(err) != "invalid-output" {
			t.Fatalf("Discover(%s) error = %v, want invalid-output", scan, err)
		}
	}
}

func TestDiscoverySkipsInvalidDeviceTypes(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda")
	scan := []byte(`{"devices":[{"name":"/dev/sda","type":"sat;invalid"}]}`)

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatalf("Discover() error = %v, want invalid entry skipped", err)
	}

	if got := registry.Devices(); len(got) != 0 {
		t.Fatalf("invalid scan type produced devices %+v, want empty", got)
	}
}

func TestDiscoveryRejectsInvalidPathsAndPartitions(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda")
	scan := func(path string) []byte {
		return []byte(`{"devices":[{"name":"` + path + `","type":"scsi"}]}`)
	}

	for _, path := range []string{"/etc/passwd", "/dev/sda1", "/dev/st0", "/dev/../etc/passwd"} {
		if err := registry.Discover(scan(path), []byte(`{}`)); err != nil {
			t.Fatalf("Discover(%q) returned error %v, want invalid entry skipped", path, err)
		}

		if got := registry.Devices(); len(got) != 0 {
			t.Fatalf("Discover(%q) devices = %+v, want empty", path, got)
		}
	}
}

func TestRediscoveryKeepsIDAndBindingChangesDisconnectOldID(t *testing.T) {
	registry, operatingSystem := registryWithPaths("/dev/sda")
	scan := []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`)

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	first := registry.Devices()[0]

	if first.USBBridge != nil {
		t.Fatalf("non-USB device usbBridge = %v, want null", first.USBBridge)
	}

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	if got := registry.Devices()[0].DeviceID; got != first.DeviceID {
		t.Fatalf("stable rediscovery ID = %q, want %q", got, first.DeviceID)
	}

	if _, err := registry.Accept(string(first.DeviceID), model.Sample{Identity: model.Identity{WWN: textPointer("disk-wwn")}}, 0); err != nil {
		t.Fatal(err)
	}

	changedTypeScan := []byte(`{"devices":[{"name":"/dev/sda","type":"scsi"}]}`)

	if err := registry.Discover(changedTypeScan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	typeChangedDevices := registry.Devices()

	if len(typeChangedDevices) != 2 || typeChangedDevices[0].DeviceID == first.DeviceID || typeChangedDevices[0].DeviceType != "scsi" || typeChangedDevices[0].DeviceTypeSource != model.DeviceTypeSourceScan || typeChangedDevices[0].Binding != model.BindingProvisional || typeChangedDevices[0].Sample != nil {
		t.Fatalf("after type-only change = %+v, want new provisional scsi ID", typeChangedDevices)
	}

	var oldTypeDevice *model.Device

	for index := range typeChangedDevices {
		if typeChangedDevices[index].DeviceID == first.DeviceID {
			oldTypeDevice = &typeChangedDevices[index]
		}
	}

	if oldTypeDevice == nil || oldTypeDevice.Binding != model.BindingDisconnected || oldTypeDevice.DeviceType != "sat" || oldTypeDevice.Sample == nil {
		t.Fatalf("old type record after type-only change = %+v, want disconnected sat record with sample", oldTypeDevice)
	}

	typeChangedID := typeChangedDevices[0].DeviceID
	operatingSystem.bindings["/dev/sda"] = Binding{Path: "/dev/sda", Token: "replacement"}

	if err := registry.Discover(changedTypeScan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	devices := registry.Devices()

	if len(devices) != 3 || devices[0].DeviceID == typeChangedID || devices[0].DeviceID == first.DeviceID || devices[0].Binding != model.BindingProvisional {
		t.Fatalf("after binding replacement = %+v, want a third current provisional ID", devices)
	}

	for _, device := range devices[1:] {
		if device.Binding != model.BindingDisconnected {
			t.Fatalf("binding-replaced record = %+v, want disconnected", device)
		}
	}
}

func TestDeviceTypeOverride(t *testing.T) {
	registry, operatingSystem := registryWithPaths("/dev/sda")
	operatingSystem.bindings["/dev/sda"] = Binding{Path: "/dev/sda", Token: "token:/dev/sda", USBBridge: "1058:25a0"}
	scan := []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`)

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	device := registry.Devices()[0]
	identity := model.Identity{WWN: textPointer("disk-wwn")}

	if _, err := registry.Accept(string(device.DeviceID), model.Sample{Identity: identity}, 0); err != nil {
		t.Fatalf("Accept() seed identity: %v", err)
	}

	registry.RecordAttempt(string(device.DeviceID), model.CollectionCommandFailed, intPointer(7), "2026-11-24T12:00:00Z")

	sameAsScan := "sat"
	response, err := registry.SetDeviceType(string(device.DeviceID), &sameAsScan)
	if err != nil {
		t.Fatalf("SetDeviceType(%q): %v", sameAsScan, err)
	}

	if response.DeviceID != device.DeviceID || response.DeviceType != model.Text(sameAsScan) || response.DeviceTypeSource != model.DeviceTypeSourceUser {
		t.Fatalf("SetDeviceType(%q) response = %+v", sameAsScan, response)
	}

	devices := registry.Devices()

	if len(devices) != 1 || devices[0].DeviceID != device.DeviceID || devices[0].DeviceType != "sat" || devices[0].DeviceTypeSource != model.DeviceTypeSourceUser || devices[0].Binding != model.BindingProvisional || devices[0].Sample != nil || devices[0].Collection.Status != model.CollectionNeverRead || devices[0].Collection.ExitCode != nil || devices[0].Freshness.LastAttemptAt != nil || devices[0].Freshness.LastSuccessAt != nil || !devices[0].Freshness.Stale {
		t.Fatalf("same-as-scan override did not clear read state: %+v", devices)
	}

	changedIdentity := model.Identity{WWN: textPointer("different-wwn")}
	accepted, err := registry.Accept(string(device.DeviceID), model.Sample{Identity: changedIdentity}, 0)
	if err != nil || accepted.BindingChanged || accepted.DeviceID != device.DeviceID {
		t.Fatalf("Accept() after override = %+v, %v; want same ID without identity replacement", accepted, err)
	}

	for _, deviceType := range []string{"scsi", "nvme", "sntasmedia", "sntjmicron", "sntrealtek"} {
		response, err = registry.SetDeviceType(string(device.DeviceID), &deviceType)
		if err != nil {
			t.Fatalf("SetDeviceType(%q): %v", deviceType, err)
		}

		if response.DeviceID != device.DeviceID || response.DeviceType != model.Text(deviceType) || response.DeviceTypeSource != model.DeviceTypeSourceUser {
			t.Fatalf("SetDeviceType(%q) response = %+v", deviceType, response)
		}
	}

	devices = registry.Devices()

	if len(devices) != 1 || devices[0].DeviceID != device.DeviceID || devices[0].DeviceType != "sntrealtek" || devices[0].DeviceTypeSource != model.DeviceTypeSourceUser {
		t.Fatalf("override state = %+v, want same user-selected device", devices)
	}

	reset := devices[0]

	if reset.Binding != model.BindingProvisional || reset.Sample != nil || reset.Collection.Status != model.CollectionNeverRead || reset.Collection.ExitCode != nil || reset.Freshness.LastAttemptAt != nil || reset.Freshness.LastSuccessAt != nil || !reset.Freshness.Stale {
		t.Fatalf("override retained prior read state: %+v", reset)
	}

	if reset.USBBridge == nil || *reset.USBBridge != "1058:25a0" {
		t.Fatalf("USB bridge = %v, want lower-case VID:PID", reset.USBBridge)
	}

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatalf("Discover() after override: %v", err)
	}

	devices = registry.Devices()

	if len(devices) != 1 || devices[0].DeviceID != device.DeviceID || devices[0].DeviceType != "sntrealtek" || devices[0].DeviceTypeSource != model.DeviceTypeSourceUser {
		t.Fatalf("rediscovery lost override or ID: %+v", devices)
	}

	response, err = registry.SetDeviceType(string(device.DeviceID), nil)
	if err != nil || response.DeviceType != "sat" || response.DeviceTypeSource != model.DeviceTypeSourceScan {
		t.Fatalf("SetDeviceType(reset) = %+v, %v; want scan type", response, err)
	}

	if got := registry.Devices()[0]; got.DeviceID != device.DeviceID || got.DeviceType != "sat" || got.DeviceTypeSource != model.DeviceTypeSourceScan {
		t.Fatalf("reset state = %+v, want original ID and scan type", got)
	}

	if _, err := registry.SetDeviceType("missing", nil); ErrorCode(err) != "unknown-device" {
		t.Fatalf("SetDeviceType(unknown) error = %v, want unknown-device", err)
	}

	invalid := "sat;bad"

	if _, err := registry.SetDeviceType(string(device.DeviceID), &invalid); ErrorCode(err) != "bad-request" {
		t.Fatalf("SetDeviceType(invalid) error = %v, want bad-request", err)
	}

	if err := registry.Discover([]byte(`{"devices":[]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	if _, err := registry.SetDeviceType(string(device.DeviceID), &invalid); ErrorCode(err) != "disconnected" {
		t.Fatalf("SetDeviceType(disconnected) error = %v, want disconnected", err)
	}
}

func TestIdentityAcceptanceUsesExactIdentityAndMarksDuplicatesUnreliable(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda", "/dev/sdb")
	scan := []byte(`{"devices":[{"name":"/dev/sda","type":"sat"},{"name":"/dev/sdb","type":"sat"}]}`)

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	devices := registry.Devices()
	firstID, secondID := string(devices[0].DeviceID), string(devices[1].DeviceID)

	identity := model.Identity{WWN: textPointer(" WWN ")}
	first, err := registry.Accept(firstID, model.Sample{Identity: identity}, 0)
	if err != nil || !first.Reliable || first.IdentityKey == "" {
		t.Fatalf("first Accept() = %+v, %v; want reliable identity", first, err)
	}

	second, err := registry.Accept(secondID, model.Sample{Identity: identity}, 0)
	if err != nil || second.Reliable {
		t.Fatalf("duplicate Accept() = %+v, %v; want unreliable", second, err)
	}

	devices = registry.Devices()

	for _, device := range devices {
		if device.Sample == nil || device.Sample.Identity.Reliable {
			t.Fatalf("duplicate identity device = %+v, want unreliable sample", device)
		}
	}

	changed := model.Identity{Serial: textPointer("A  b"), Model: textPointer("Disk"), CapacityBytes: stringPointer("1000")}
	identityKeyA := makeIdentityKey(model.Identity{Serial: textPointer("A b"), Model: textPointer("Disk"), CapacityBytes: stringPointer("1000")})
	identityKeyB := makeIdentityKey(changed)

	if identityKeyA == identityKeyB {
		t.Fatal("identity keys merged serials with different spaces")
	}
}

func TestAcceptIdentityChangeCreatesNewDeviceRecord(t *testing.T) {
	registry, _ := registryWithPaths("/dev/sda")

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	oldID := registry.Devices()[0].DeviceID
	oldIdentity := model.Identity{Serial: textPointer("old-serial"), Model: textPointer("Disk"), CapacityBytes: stringPointer("1000")}

	if _, err := registry.Accept(string(oldID), model.Sample{Identity: oldIdentity}, 0); err != nil {
		t.Fatal(err)
	}

	newIdentity := model.Identity{Serial: textPointer("new-serial"), Model: textPointer("Disk"), CapacityBytes: stringPointer("1000")}
	accepted, err := registry.Accept(string(oldID), model.Sample{Identity: newIdentity}, 0)
	if err != nil {
		t.Fatal(err)
	}

	devices := registry.Devices()

	if !accepted.BindingChanged || accepted.DeviceID == oldID || len(devices) != 2 || devices[0].DeviceID != accepted.DeviceID || devices[1].DeviceID != oldID || devices[1].Binding != model.BindingDisconnected {
		t.Fatalf("identity replacement accepted=%+v devices=%+v, want new current ID and old disconnected record", accepted, devices)
	}

	currentID := accepted.DeviceID

	for index := 0; index < MaxRetainedDevices+1; index++ {
		identity := model.Identity{WWN: textPointer(fmt.Sprintf("wwn-%d", index))}
		accepted, err = registry.Accept(string(currentID), model.Sample{Identity: identity}, 0)
		if err != nil {
			t.Fatalf("Accept replacement %d: %v", index, err)
		}

		currentID = accepted.DeviceID
	}

	if _, err := registry.Target(string(oldID)); errorCode(err) != "unknown-device" {
		t.Fatalf("Target(evicted identity) error = %v, want unknown-device", err)
	}

	if _, err := registry.Target(string(currentID)); err != nil {
		t.Fatalf("Target(current identity) error = %v, want success", err)
	}
}

func TestTargetRejectsChangedOSBinding(t *testing.T) {
	registry, operatingSystem := registryWithPaths("/dev/sda")

	if err := registry.Discover([]byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	id := registry.Devices()[0].DeviceID
	operatingSystem.bindings["/dev/sda"] = Binding{Path: "/dev/sda", Token: "different"}

	if _, err := registry.Target(string(id)); errorCode(err) != "disconnected" {
		t.Fatalf("Target() error = %v, want disconnected", err)
	}
}

func TestDisconnectedSnapshotRespectsCacheLimit(t *testing.T) {
	paths := make([]string, model.MaxCurrentDevices)
	entries := make([]map[string]string, 0, len(paths))

	for index := range paths {
		paths[index] = "/dev/sd" + string(rune('a'+index))
		entries = append(entries, map[string]string{"name": paths[index], "type": "scsi"})
	}

	registry, operatingSystem := registryWithPaths(paths...)
	scan, _ := json.Marshal(map[string]any{"devices": entries})

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	operatingSystem.bindings["/dev/sdq"] = Binding{Path: "/dev/sdq", Token: "token:/dev/sdq"}
	operatingSystem.bindings["/dev/sdr"] = Binding{Path: "/dev/sdr", Token: "token:/dev/sdr"}
	entries = append(entries[2:], map[string]string{"name": "/dev/sdq", "type": "scsi"}, map[string]string{"name": "/dev/sdr", "type": "scsi"})
	scan, _ = json.Marshal(map[string]any{"devices": entries})

	if err := registry.Discover(scan, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	if err := registry.Discover([]byte(`{"devices":[]}`), []byte(`{}`)); err != nil {
		t.Fatal(err)
	}

	devices, truncated, disconnectedTruncated := registry.VisibleDevices()

	if len(devices) != MaxUnmappedDisconnectedCache || truncated || disconnectedTruncated {
		t.Fatalf("visible=%d truncated=%v disconnectedTruncated=%v", len(devices), truncated, disconnectedTruncated)
	}
}

func TestDiscoveryEvictsOldUnmappedDisconnectedRecords(t *testing.T) {
	registry, operatingSystem := registryWithPaths("/dev/sda")
	scan := []byte(`{"devices":[{"name":"/dev/sda","type":"scsi"}]}`)
	var firstID model.ID
	var latestID model.ID

	for index := 0; index < 20; index++ {
		operatingSystem.bindings["/dev/sda"] = Binding{Path: "/dev/sda", Token: fmt.Sprintf("binding-%d", index)}

		if err := registry.Discover(scan, []byte(`{}`)); err != nil {
			t.Fatalf("Discover replacement %d: %v", index, err)
		}

		ids, _ := registry.CurrentIDs()

		if len(ids) != 1 {
			t.Fatalf("current IDs after replacement %d = %v, want one", index, ids)
		}

		if index == 0 {
			firstID = ids[0]
		}

		latestID = ids[0]

		if err := registry.Discover([]byte(`{"devices":[]}`), []byte(`{}`)); err != nil {
			t.Fatalf("Discover empty scan %d: %v", index, err)
		}
	}

	if _, err := registry.Target(string(firstID)); errorCode(err) != "unknown-device" {
		t.Fatalf("Target(old disconnected record) error = %v, want unknown-device", err)
	}

	if _, err := registry.Target(string(latestID)); errorCode(err) != "disconnected" {
		t.Fatalf("Target(recent disconnected record) error = %v, want disconnected", err)
	}
}

func TestSysfsBindingIncludesUSBIdentityAndRejectsPartition(t *testing.T) {
	sysRoot := t.TempDir()
	devicePath := filepath.Join(sysRoot, "devices", "platform", "11200000.xhci", "usb2", "2-1", "2-1:1.0", "host0", "target0:0:0", "0:0:0:0", "block", "sda")
	usbPath := filepath.Join(sysRoot, "devices", "platform", "11200000.xhci", "usb2", "2-1")

	if err := os.MkdirAll(devicePath, 0o755); err != nil {
		t.Fatal(err)
	}

	for name, value := range map[string]string{"idVendor": "1058\n", "idProduct": "25A0\n", "serial": "disk-serial\n"} {
		if err := os.WriteFile(filepath.Join(usbPath, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := os.MkdirAll(filepath.Join(sysRoot, "dev", "block"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(devicePath, filepath.Join(sysRoot, "dev", "block", "8:0")); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(filepath.Join(sysRoot, "block", "sda"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(sysRoot, "block", "sda", "size"), []byte("3907029168\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	binding, err := inspectSysfs(sysRoot, "8:0")
	if err != nil {
		t.Fatalf("inspectSysfs() error = %v", err)
	}

	canonicalDevicePath, err := filepath.EvalSymlinks(devicePath)
	if err != nil {
		t.Fatal(err)
	}

	if binding.devicePath != canonicalDevicePath || binding.size != "3907029168" || binding.usbBridge != "1058:25a0" || binding.usbVendor.value != "1058" || binding.usbVendor.status != "present" || binding.usbProduct.value != "25A0" || binding.usbProduct.status != "present" || binding.usbSerial.value != "disk-serial" || binding.usbSerial.status != "present" {
		t.Fatalf("sysfs binding = %+v", binding)
	}

	for _, test := range []struct {
		name    string
		vendor  string
		product string
	}{
		{name: "non-hex vendor", vendor: "xyz1\n", product: "25A0\n"},
		{name: "wrong-length product", vendor: "1058\n", product: "25A\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(usbPath, "idVendor"), []byte(test.vendor), 0o600); err != nil {
				t.Fatal(err)
			}

			if err := os.WriteFile(filepath.Join(usbPath, "idProduct"), []byte(test.product), 0o600); err != nil {
				t.Fatal(err)
			}

			binding, err := inspectSysfs(sysRoot, "8:0")
			if err != nil {
				t.Fatalf("inspectSysfs() with malformed USB IDs: %v", err)
			}

			if binding.devicePath != canonicalDevicePath || binding.size != "3907029168" || binding.usbBridge != "" || binding.usbVendor.value != strings.TrimRight(test.vendor, "\r\n") || binding.usbProduct.value != strings.TrimRight(test.product, "\r\n") {
				t.Fatalf("malformed USB binding = %+v, want valid disk without bridge hint", binding)
			}
		})
	}

	if err := os.Remove(filepath.Join(usbPath, "idVendor")); err != nil {
		t.Fatal(err)
	}

	if err := os.Mkdir(filepath.Join(usbPath, "idVendor"), 0o755); err != nil {
		t.Fatal(err)
	}

	binding, err = inspectSysfs(sysRoot, "8:0")
	if err != nil || binding.devicePath != canonicalDevicePath || binding.usbBridge != "" || binding.usbVendor.status != "unreadable" || binding.usbProduct.value != "25A" {
		t.Fatalf("unreadable USB identity binding = %+v, %v; want valid disk without bridge hint", binding, err)
	}

	partitionPath := filepath.Join(devicePath, "sda1")

	if err := os.MkdirAll(partitionPath, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(partitionPath, "partition"), []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(partitionPath, filepath.Join(sysRoot, "dev", "block", "8:1")); err != nil {
		t.Fatal(err)
	}

	if _, err := inspectSysfs(sysRoot, "8:1"); err == nil || !strings.Contains(err.Error(), "partition") {
		t.Fatalf("partition inspect error = %v, want partition rejection", err)
	}
}

func textPointer(value string) *model.Text {
	result := model.Text(value)

	return &result
}

func stringPointer(value string) *string {
	return &value
}
