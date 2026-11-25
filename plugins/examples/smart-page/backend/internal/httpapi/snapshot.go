package httpapi

import (
	"encoding/json"
	"errors"
	"unicode/utf8"

	"smart-page/internal/model"
)

var errSnapshotCoreTooLarge = errors.New("snapshot core exceeds wire budget")

// EncodeSnapshot bounds a snapshot for the wire without modifying cached state.
func EncodeSnapshot(input model.Snapshot) ([]byte, error) {
	snapshot := cloneSnapshotForEncoding(input)
	truncated := snapshot.Truncated || snapshot.DisconnectedTruncated

	boundSnapshotStrings(&snapshot, &truncated)

	attributes := make([][]model.Attribute, len(snapshot.Devices))

	for index := range snapshot.Devices {
		device := &snapshot.Devices[index]

		if device.Sample == nil {
			continue
		}

		attributes[index] = device.Sample.Attributes
		device.Sample.Attributes = []model.Attribute{}
	}

	snapshot.Truncated = truncated || anyTruncatedDevice(snapshot.Devices)

	base, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	if len(base) > model.MaxSnapshotBytes {
		return nil, errSnapshotCoreTooLarge
	}

	retainedByDevice := make([]int, len(snapshot.Devices))
	retainedPayloadBytes := 0

	for round := 0; ; round++ {
		active := false

		for deviceIndex, deviceAttributes := range attributes {
			if round >= len(deviceAttributes) || retainedByDevice[deviceIndex] != round {
				continue
			}

			active = true
			attribute := deviceAttributes[round]
			encodedAttribute, marshalErr := json.Marshal(attribute)

			if marshalErr != nil {
				return nil, marshalErr
			}

			addition := len(encodedAttribute)

			if retainedByDevice[deviceIndex] > 0 {
				addition++
			}

			if len(base)+retainedPayloadBytes+addition > model.MaxSnapshotBytes {
				snapshot.Devices[deviceIndex].Truncated = true
				truncated = true

				continue
			}

			snapshot.Devices[deviceIndex].Sample.Attributes = append(snapshot.Devices[deviceIndex].Sample.Attributes, attribute)
			retainedByDevice[deviceIndex]++
			retainedPayloadBytes += addition
		}

		if !active {
			break
		}
	}

	snapshot.Truncated = truncated || anyTruncatedDevice(snapshot.Devices)
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	if len(encoded) > model.MaxSnapshotBytes {
		return nil, errSnapshotCoreTooLarge
	}

	return encoded, nil
}

func cloneSnapshotForEncoding(snapshot model.Snapshot) model.Snapshot {
	snapshot.Devices = append([]model.Device{}, snapshot.Devices...)
	groups := snapshot.Diagnostics.Groups

	if len(groups) > model.MaxDiagnosticGroups {
		groups = groups[:model.MaxDiagnosticGroups]
		snapshot.Truncated = true
	}

	snapshot.Diagnostics.Groups = append([]uint32{}, groups...)
	reasons := snapshot.Diagnostics.Reasons

	if len(reasons) > model.MaxDiagnosticReasons {
		reasons = reasons[:model.MaxDiagnosticReasons]
		snapshot.Truncated = true
	}

	snapshot.Diagnostics.Reasons = append([]model.Text{}, reasons...)

	for index := range snapshot.Devices {
		device := &snapshot.Devices[index]

		if device.Sample != nil {
			sample := *device.Sample
			sample.Counters = append([]model.Counter{}, sample.Counters...)
			sample.Assessment.Reasons = append([]model.Reason{}, sample.Assessment.Reasons...)
			attributes := sample.Attributes

			if len(attributes) > model.MaxSampleAttributes {
				attributes = attributes[:model.MaxSampleAttributes]
				device.Truncated = true
				snapshot.Truncated = true
			}

			sample.Attributes = append([]model.Attribute{}, attributes...)

			device.Sample = &sample
		}
	}

	return snapshot
}

func boundSnapshotStrings(snapshot *model.Snapshot, truncated *bool) {
	for index := range snapshot.Devices {
		device := &snapshot.Devices[index]
		wasTruncated := false
		device.Path = model.Text(boundString(string(device.Path), &wasTruncated))

		if device.Sample != nil {
			sample := device.Sample

			for attributeIndex := range sample.Attributes {
				sample.Attributes[attributeIndex].Name = model.Text(boundString(string(sample.Attributes[attributeIndex].Name), &wasTruncated))

				boundTextPointer(&sample.Attributes[attributeIndex].Raw, &wasTruncated)
			}
		}

		if wasTruncated {
			device.Truncated = true
		}

		if device.Truncated {
			*truncated = true
		}
	}

	boundTextPointer(&snapshot.Diagnostics.Utility.Path, truncated)
	boundTextPointer(&snapshot.Diagnostics.Utility.Version, truncated)
	boundTextPointer(&snapshot.Diagnostics.Smartd.Reason, truncated)

	for index := range snapshot.Diagnostics.Reasons {
		snapshot.Diagnostics.Reasons[index] = model.Text(boundString(string(snapshot.Diagnostics.Reasons[index]), truncated))
	}
}

func boundString(value string, truncated *bool) string {
	if len(value) <= model.MaxDeviceStringBytes && utf8.ValidString(value) {
		return value
	}

	bounded := make([]byte, 0, model.MaxDeviceStringBytes)
	offset := 0

	for offset < len(value) {
		character, width := utf8.DecodeRuneInString(value[offset:])
		encoded := value[offset : offset+width]

		if character == utf8.RuneError && width == 1 {
			encoded = "\uFFFD"
			*truncated = true
		}

		if len(bounded)+len(encoded) > model.MaxDeviceStringBytes {
			*truncated = true

			break
		}

		bounded = append(bounded, encoded...)
		offset += width
	}

	if offset < len(value) {
		*truncated = true
	}

	return string(bounded)
}

func boundTextPointer(pointer **model.Text, truncated *bool) {
	if pointer == nil || *pointer == nil {
		return
	}

	value := model.Text(boundString(string(**pointer), truncated))
	*pointer = &value
}

func anyTruncatedDevice(devices []model.Device) bool {
	for _, device := range devices {
		if device.Truncated {
			return true
		}
	}

	return false
}
