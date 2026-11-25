package devices

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"smart-page/internal/model"
)

const MaxRetainedDevices = 64
const MaxUnmappedDisconnectedCache = 16
const maxInspectionAttempts = 3

var fallbackID atomic.Uint64

type Binding struct {
	Path      string
	Token     string
	USBBridge string
}

type OS interface {
	Inspect(path string) (Binding, error)
}

type Accepted struct {
	DeviceID       model.ID
	Reliable       bool
	IdentityKey    string
	BindingChanged bool
}

type Error struct {
	Code string
}

func (deviceError *Error) Error() string {
	return deviceError.Code
}

type InspectionRaceError struct{}

func (*InspectionRaceError) Error() string {
	return "registry changed during inspection"
}

func IsInspectionRace(err error) bool {
	var raceError *InspectionRaceError

	return errors.As(err, &raceError)
}

type record struct {
	device         model.Device
	binding        Binding
	scanDeviceType string
	current        bool
	identityKey    string
	reliable       bool
	sequence       uint64
}

type Registry struct {
	mu         sync.Mutex
	operating  OS
	newID      func() string
	records    map[model.ID]*record
	order      []model.ID
	current    map[string]model.ID
	sequence   uint64
	generation uint64
	truncated  bool
}

type scanDevice struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

func NewRegistry(operatingSystem OS, newID func() string) *Registry {
	if newID == nil {
		newID = randomID
	}

	return &Registry{
		operating: operatingSystem,
		newID:     newID,
		records:   make(map[model.ID]*record),
		current:   make(map[string]model.ID),
	}
}

func (registry *Registry) Discover(plain []byte, scsi []byte) error {
	plainDevices, err := parseScan(plain)
	if err != nil {
		return err
	}

	scsiDevices, err := parseScan(scsi)
	if err != nil {
		return err
	}

	for attempt := 0; attempt < maxInspectionAttempts; attempt++ {
		registry.mu.Lock()

		generation := registry.generation

		registry.mu.Unlock()

		byPath := make(map[string]discoveredDevice)

		for _, device := range append(plainDevices, scsiDevices...) {
			if !validScanPath(device.Name) || !validDeviceType(device.Type) || registry.operating == nil {
				continue
			}

			binding, inspectErr := registry.operating.Inspect(device.Name)

			if inspectErr != nil || !validCanonicalPath(binding.Path) || binding.Token == "" {
				continue
			}

			if len(binding.Path) > model.MaxDeviceStringBytes {
				continue
			}

			if _, exists := byPath[binding.Path]; exists {
				continue
			}

			byPath[binding.Path] = discoveredDevice{binding: binding, deviceType: device.Type}
		}

		registry.mu.Lock()

		if registry.generation != generation {
			registry.mu.Unlock()

			continue
		}

		previous := registry.current
		registry.current = make(map[string]model.ID)

		for _, entry := range registry.records {
			entry.current = false
		}

		paths := make([]string, 0, len(byPath))

		for path := range byPath {
			paths = append(paths, path)
		}

		sort.Strings(paths)

		registry.truncated = len(paths) > model.MaxCurrentDevices

		if registry.truncated {
			paths = paths[:model.MaxCurrentDevices]
		}

		for _, path := range paths {
			discovered := byPath[path]
			entry := registry.findReusable(path, discovered.deviceType, discovered.binding, previous)

			if entry == nil {
				entry = registry.newRecord(path, discovered.deviceType, discovered.binding)
			}

			entry.current = true
			entry.device.Binding = model.BindingProvisional
			entry.device.Path = model.Text(path)
			entry.scanDeviceType = discovered.deviceType

			if entry.device.DeviceTypeSource != model.DeviceTypeSourceUser {
				entry.device.DeviceType = model.Text(discovered.deviceType)
				entry.device.DeviceTypeSource = model.DeviceTypeSourceScan
			}

			registry.current[path] = entry.device.DeviceID
		}

		registry.evictLocked()
		registry.recalculateIdentityReliabilityLocked()

		registry.generation++

		registry.mu.Unlock()

		return nil
	}

	return &InspectionRaceError{}
}

func (registry *Registry) Target(deviceID string) (model.Target, error) {
	for attempt := 0; attempt < maxInspectionAttempts; attempt++ {
		registry.mu.Lock()

		entry, exists := registry.records[model.ID(deviceID)]

		if !exists {
			registry.mu.Unlock()

			return model.Target{}, &Error{Code: "unknown-device"}
		}

		if !entry.current || registry.operating == nil {
			registry.mu.Unlock()

			return model.Target{}, &Error{Code: "disconnected"}
		}

		path := string(entry.device.Path)
		expectedBinding := entry.binding
		expectedType := string(entry.device.DeviceType)
		generation := registry.generation
		operatingSystem := registry.operating

		registry.mu.Unlock()

		binding, err := operatingSystem.Inspect(path)

		registry.mu.Lock()

		if registry.generation != generation {
			registry.mu.Unlock()

			continue
		}

		entry, exists = registry.records[model.ID(deviceID)]

		if !exists || !entry.current || entry.binding != expectedBinding || entry.device.Path != model.Text(path) || entry.device.DeviceType != model.Text(expectedType) {
			registry.mu.Unlock()

			return model.Target{}, &Error{Code: "disconnected"}
		}

		if err != nil || !sameBinding(binding, expectedBinding) {
			registry.disconnectLocked(entry)
			registry.mu.Unlock()

			return model.Target{}, &Error{Code: "disconnected"}
		}

		registry.mu.Unlock()

		return model.Target{
			Path:         expectedBinding.Path,
			Type:         expectedType,
			BindingToken: expectedBinding.Token,
		}, nil
	}

	return model.Target{}, &Error{Code: "busy"}
}

func (registry *Registry) Accept(deviceID string, sample model.Sample, exitCode int) (Accepted, error) {
	for attempt := 0; attempt < maxInspectionAttempts; attempt++ {
		registry.mu.Lock()

		entry, exists := registry.records[model.ID(deviceID)]

		if !exists {
			registry.mu.Unlock()

			return Accepted{}, &Error{Code: "unknown-device"}
		}

		if !entry.current || registry.operating == nil {
			registry.mu.Unlock()

			return Accepted{}, &Error{Code: "disconnected"}
		}

		path := string(entry.device.Path)
		expectedBinding := entry.binding
		expectedType := string(entry.device.DeviceType)
		generation := registry.generation
		operatingSystem := registry.operating

		registry.mu.Unlock()

		binding, err := operatingSystem.Inspect(path)

		registry.mu.Lock()

		if registry.generation != generation {
			registry.mu.Unlock()

			continue
		}

		entry, exists = registry.records[model.ID(deviceID)]

		if !exists || !entry.current || entry.binding != expectedBinding || entry.device.Path != model.Text(path) || entry.device.DeviceType != model.Text(expectedType) {
			registry.mu.Unlock()

			return Accepted{}, &Error{Code: "disconnected"}
		}

		if err != nil || !sameBinding(binding, expectedBinding) {
			registry.disconnectLocked(entry)
			registry.mu.Unlock()

			return Accepted{}, &Error{Code: "disconnected"}
		}

		identityKey, reliable := makeIdentityKeyAndReliability(sample.Identity)
		bindingChanged := false

		if entry.identityKey != "" && identityKey != "" && entry.identityKey != identityKey {
			scanDeviceType := entry.scanDeviceType
			effectiveDeviceType := entry.device.DeviceType
			deviceTypeSource := entry.device.DeviceTypeSource
			entry.current = false
			entry.device.Binding = model.BindingDisconnected
			entry.device.Collection.Status = model.CollectionDisconnected
			entry.device.Freshness.Stale = true

			delete(registry.current, entry.binding.Path)

			entry = registry.newRecord(entry.binding.Path, scanDeviceType, entry.binding)
			entry.device.DeviceType = effectiveDeviceType
			entry.device.DeviceTypeSource = deviceTypeSource
			entry.current = true
			registry.current[entry.binding.Path] = entry.device.DeviceID
			bindingChanged = true
		}

		sample.DeviceID = entry.device.DeviceID
		sample.Identity.Reliable = reliable
		entry.device.Sample = &sample
		entry.device.Binding = model.BindingValidated
		entry.device.Collection = model.Collection{Status: model.CollectionOK, ExitCode: intPointer(exitCode)}

		if sample.SampledAt != "" {
			attemptedAt := sample.SampledAt
			successAt := sample.SampledAt
			entry.device.Freshness.LastAttemptAt = &attemptedAt
			entry.device.Freshness.LastSuccessAt = &successAt
		}

		entry.device.Freshness.Stale = false
		entry.identityKey = identityKey
		entry.reliable = reliable

		registry.evictLocked()
		registry.recalculateIdentityReliabilityLocked()

		registry.generation++

		if entry.device.Sample != nil {
			reliable = entry.device.Sample.Identity.Reliable
		}

		accepted := Accepted{
			DeviceID:       entry.device.DeviceID,
			Reliable:       reliable,
			IdentityKey:    identityKey,
			BindingChanged: bindingChanged,
		}

		registry.mu.Unlock()

		return accepted, nil
	}

	return Accepted{}, &InspectionRaceError{}
}

func (registry *Registry) RecordAttempt(deviceID string, status model.CollectionStatus, exitCode *int, attemptedAt model.DateTime) {
	registry.mu.Lock()

	defer registry.mu.Unlock()

	entry, exists := registry.records[model.ID(deviceID)]

	if !exists || !entry.current {
		return
	}

	entry.device.Collection = model.Collection{Status: status, ExitCode: cloneInt(exitCode)}
	attempt := attemptedAt
	entry.device.Freshness.LastAttemptAt = &attempt
	entry.device.Freshness.Stale = true
}

func (registry *Registry) SetDeviceType(deviceID string, deviceType *string) (model.DeviceTypeResponse, error) {
	registry.mu.Lock()

	defer registry.mu.Unlock()

	entry, exists := registry.records[model.ID(deviceID)]

	if !exists {
		return model.DeviceTypeResponse{}, &Error{Code: "unknown-device"}
	}

	if !entry.current {
		return model.DeviceTypeResponse{}, &Error{Code: "disconnected"}
	}

	selectedType := entry.scanDeviceType
	source := model.DeviceTypeSourceScan

	if deviceType != nil {
		if !validDeviceTypeOverride(*deviceType) {
			return model.DeviceTypeResponse{}, &Error{Code: "bad-request"}
		}

		selectedType = *deviceType
		source = model.DeviceTypeSourceUser
	}

	entry.device.DeviceType = model.Text(selectedType)
	entry.device.DeviceTypeSource = source
	entry.device.Binding = model.BindingProvisional
	entry.device.Sample = nil
	entry.device.Collection = model.Collection{Status: model.CollectionNeverRead}
	entry.device.Freshness = model.Freshness{Stale: true}
	entry.identityKey = ""
	entry.reliable = false

	registry.recalculateIdentityReliabilityLocked()

	registry.generation++

	return model.DeviceTypeResponse{
		SchemaVersion:    1,
		DeviceID:         entry.device.DeviceID,
		DeviceType:       entry.device.DeviceType,
		DeviceTypeSource: entry.device.DeviceTypeSource,
	}, nil
}

func (registry *Registry) Devices() []model.Device {
	devices, _, _ := registry.VisibleDevices()

	return devices
}

func (registry *Registry) CurrentIDs() ([]model.ID, bool) {
	registry.mu.Lock()

	defer registry.mu.Unlock()

	paths := sortedCurrentPaths(registry.current)
	ids := make([]model.ID, 0, len(paths))

	for _, path := range paths {
		ids = append(ids, registry.current[path])
	}

	return ids, registry.truncated
}

func (registry *Registry) VisibleDevices() ([]model.Device, bool, bool) {
	registry.mu.Lock()

	defer registry.mu.Unlock()

	currentPaths := sortedCurrentPaths(registry.current)
	devices := make([]model.Device, 0, model.MaxSnapshotDevices)

	for _, path := range currentPaths {
		if len(devices) == model.MaxSnapshotDevices {
			break
		}

		if entry := registry.records[registry.current[path]]; entry != nil {
			devices = append(devices, cloneDevice(entry.device))
		}
	}

	disconnected := make([]*record, 0)

	for _, id := range registry.order {
		entry := registry.records[id]

		if entry != nil && !entry.current {
			disconnected = append(disconnected, entry)
		}
	}

	sort.Slice(disconnected, func(left int, right int) bool {
		leftSuccess := disconnected[left].device.Freshness.LastSuccessAt
		rightSuccess := disconnected[right].device.Freshness.LastSuccessAt

		if leftSuccess == nil && rightSuccess != nil {
			return false
		}

		if leftSuccess != nil && rightSuccess == nil {
			return true
		}

		if leftSuccess != nil && rightSuccess != nil && *leftSuccess != *rightSuccess {
			return *leftSuccess > *rightSuccess
		}

		return disconnected[left].device.DeviceID < disconnected[right].device.DeviceID
	})

	available := model.MaxSnapshotDevices - len(devices)
	disconnectedTruncated := len(disconnected) > available

	if len(disconnected) > available {
		disconnected = disconnected[:available]
	}

	for _, entry := range disconnected {
		device := cloneDevice(entry.device)
		device.Binding = model.BindingDisconnected
		device.Collection.Status = model.CollectionDisconnected
		device.Freshness.Stale = true
		devices = append(devices, device)
	}

	return devices, registry.truncated || disconnectedTruncated, disconnectedTruncated
}

func (registry *Registry) findReusable(path string, deviceType string, binding Binding, previous map[string]model.ID) *record {
	if id, exists := previous[path]; exists {
		entry := registry.records[id]

		if entry != nil && entry.scanDeviceType == deviceType && sameBinding(entry.binding, binding) {
			return entry
		}

		return nil
	}

	for index := len(registry.order) - 1; index >= 0; index-- {
		entry := registry.records[registry.order[index]]

		if entry != nil && entry.device.Path == model.Text(path) {
			if entry.scanDeviceType == deviceType && sameBinding(entry.binding, binding) {
				return entry
			}

			return nil
		}
	}

	return nil
}

func (registry *Registry) newRecord(path string, deviceType string, binding Binding) *record {
	deviceID := model.ID(registry.newID())

	for deviceID == "" || registry.records[deviceID] != nil {
		deviceID = model.ID(randomID())
	}

	registry.sequence++
	var usbBridge *model.Text

	if binding.USBBridge != "" {
		value := model.Text(binding.USBBridge)
		usbBridge = &value
	}

	entry := &record{
		device: model.Device{
			DeviceID:         deviceID,
			Path:             model.Text(path),
			DeviceType:       model.Text(deviceType),
			DeviceTypeSource: model.DeviceTypeSourceScan,
			USBBridge:        usbBridge,
			Binding:          model.BindingProvisional,
			Collection:       model.Collection{Status: model.CollectionNeverRead},
			Freshness:        model.Freshness{Stale: true},
		},
		binding:        binding,
		scanDeviceType: deviceType,
		sequence:       registry.sequence,
	}
	registry.records[deviceID] = entry
	registry.order = append(registry.order, deviceID)

	return entry
}

func validDeviceTypeOverride(deviceType string) bool {
	switch model.DeviceTypeOverride(deviceType) {
	case model.DeviceTypeSAT, model.DeviceTypeSCSI, model.DeviceTypeNVMe, model.DeviceTypeSNTASMedia, model.DeviceTypeSNTJMicron, model.DeviceTypeSNTRealtek:
		return true
	default:
		return false
	}
}

func (registry *Registry) disconnectLocked(entry *record) {
	entry.current = false
	entry.device.Binding = model.BindingDisconnected
	entry.device.Collection.Status = model.CollectionDisconnected
	entry.device.Freshness.Stale = true

	if registry.current[entry.binding.Path] == entry.device.DeviceID {
		delete(registry.current, entry.binding.Path)
	}

	registry.generation++
}

func (registry *Registry) recalculateIdentityReliabilityLocked() {
	counts := make(map[string]int)

	for _, entry := range registry.records {
		if entry.current && entry.identityKey != "" && entry.reliable {
			counts[entry.identityKey]++
		}
	}

	for _, entry := range registry.records {
		if entry.device.Sample == nil || entry.identityKey == "" {
			continue
		}

		entry.device.Sample.Identity.Reliable = entry.current && entry.reliable && counts[entry.identityKey] == 1
	}
}

func (registry *Registry) evictLocked() {
	for {
		disconnectedCount := 0

		for _, id := range registry.order {
			entry := registry.records[id]

			if entry != nil && !entry.current {
				disconnectedCount++
			}
		}

		if len(registry.records) <= MaxRetainedDevices && disconnectedCount <= MaxUnmappedDisconnectedCache {
			return
		}

		removed := false

		for index, id := range registry.order {
			entry := registry.records[id]

			if entry == nil || entry.current {
				continue
			}

			delete(registry.records, id)

			registry.order = append(registry.order[:index], registry.order[index+1:]...)
			removed = true

			break
		}

		if !removed {
			return
		}
	}
}

type discoveredDevice struct {
	binding    Binding
	deviceType string
}

func parseScan(data []byte) ([]scanDevice, error) {
	trimmed := bytes.TrimSpace(data)

	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, &Error{Code: "invalid-output"}
	}

	var scan struct {
		Devices json.RawMessage `json:"devices"`
	}

	if err := json.Unmarshal(data, &scan); err != nil {
		return nil, &Error{Code: "invalid-output"}
	}

	if len(scan.Devices) == 0 {
		return []scanDevice{}, nil
	}

	var devices []scanDevice

	if err := json.Unmarshal(scan.Devices, &devices); err != nil || devices == nil {
		return nil, &Error{Code: "invalid-output"}
	}

	return devices, nil
}

func validScanPath(path string) bool {
	return validCanonicalPath(path) && filepath.Clean(path) == path
}

func validCanonicalPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && strings.HasPrefix(path, "/dev/") && len(path) <= model.MaxDeviceStringBytes
}

func validDeviceType(deviceType string) bool {
	if deviceType == "" || len(deviceType) > model.MaxDeviceStringBytes {
		return false
	}

	for _, value := range deviceType {
		if value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' {
			continue
		}

		if strings.ContainsRune(".,:+/_-", value) {
			continue
		}

		return false
	}

	return true
}

func makeIdentityKey(identity model.Identity) string {
	key, _ := makeIdentityKeyAndReliability(identity)

	return key
}

func makeIdentityKeyAndReliability(identity model.Identity) (string, bool) {
	if identity.WWN != nil && *identity.WWN != "" {
		return "wwn:" + identityPart(string(*identity.WWN)), true
	}

	if identity.Serial == nil || *identity.Serial == "" || identity.Model == nil || *identity.Model == "" || identity.CapacityBytes == nil || *identity.CapacityBytes == "" {
		return "", false
	}

	return "serial-model-capacity:" + identityPart(string(*identity.Serial)) + identityPart(string(*identity.Model)) + identityPart(*identity.CapacityBytes), true
}

func identityPart(value string) string {
	return strconv.Itoa(len(value)) + ":" + value
}

func sameBinding(left Binding, right Binding) bool {
	return left.Path == right.Path && left.Token == right.Token
}

func sortedCurrentPaths(current map[string]model.ID) []string {
	paths := make([]string, 0, len(current))

	for path := range current {
		paths = append(paths, path)
	}

	sort.Strings(paths)

	return paths
}

func cloneDevice(device model.Device) model.Device {
	device.USBBridge = cloneText(device.USBBridge)

	if device.Sample != nil {
		sample := *device.Sample
		sample.Identity.Model = cloneText(sample.Identity.Model)
		sample.Identity.Serial = cloneText(sample.Identity.Serial)
		sample.Identity.WWN = cloneText(sample.Identity.WWN)
		sample.Identity.CapacityBytes = cloneString(sample.Identity.CapacityBytes)
		sample.TemperatureC = cloneFloat(sample.TemperatureC)
		sample.PowerOnHours = cloneString(sample.PowerOnHours)
		sample.Assessment.Reasons = append([]model.Reason(nil), sample.Assessment.Reasons...)
		sample.Counters = append([]model.Counter(nil), sample.Counters...)
		sample.Attributes = append([]model.Attribute(nil), sample.Attributes...)

		for index := range sample.Attributes {
			sample.Attributes[index].ID = cloneInt(sample.Attributes[index].ID)
			sample.Attributes[index].Raw = cloneText(sample.Attributes[index].Raw)
			sample.Attributes[index].Normalized = cloneFloat(sample.Attributes[index].Normalized)
			sample.Attributes[index].Threshold = cloneFloat(sample.Attributes[index].Threshold)
		}

		device.Sample = &sample
	}

	if device.Polling != nil {
		polling := *device.Polling

		if polling.NextDue != nil {
			nextDue := *polling.NextDue
			polling.NextDue = &nextDue
		}

		device.Polling = &polling
	}

	if device.Collection.ExitCode != nil {
		device.Collection.ExitCode = cloneInt(device.Collection.ExitCode)
	}

	if device.Freshness.LastAttemptAt != nil {
		lastAttempt := *device.Freshness.LastAttemptAt
		device.Freshness.LastAttemptAt = &lastAttempt
	}

	if device.Freshness.LastSuccessAt != nil {
		lastSuccess := *device.Freshness.LastSuccessAt
		device.Freshness.LastSuccessAt = &lastSuccess
	}

	return device
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}

func cloneText(value *model.Text) *model.Text {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}

func cloneFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}

func intPointer(value int) *int {
	return &value
}

func errorCode(err error) string {
	var deviceError *Error

	if errors.As(err, &deviceError) {
		return deviceError.Code
	}

	return ""
}

func ErrorCode(err error) string {
	return errorCode(err)
}

func randomID() string {
	value := make([]byte, 16)

	if _, err := rand.Read(value); err != nil {
		return fmt.Sprintf("device-%d", fallbackID.Add(1))
	}

	return "dev-" + hex.EncodeToString(value)
}
