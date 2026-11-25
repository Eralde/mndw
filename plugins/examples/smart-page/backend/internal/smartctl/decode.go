package smartctl

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"

	"smart-page/internal/model"
)

var errInvalidOutput = errors.New("invalid smartctl output")

func Decode(result model.CommandResult, sampledAt time.Time) (model.Sample, error) {
	if result.Failure != "" || result.ExitCode < 0 || result.ExitCode&0x3 != 0 {
		return model.Sample{}, errInvalidOutput
	}

	if len(result.Stdout) == 0 || len(result.Stdout) > model.MaxSmartctlStdoutBytes {
		return model.Sample{}, errInvalidOutput
	}

	decoder := json.NewDecoder(bytes.NewReader(result.Stdout))

	decoder.UseNumber()

	var root map[string]any

	if err := decoder.Decode(&root); err != nil || root == nil {
		return model.Sample{}, errInvalidOutput
	}

	var trailing any

	if err := decoder.Decode(&trailing); err != io.EOF {
		return model.Sample{}, errInvalidOutput
	}

	if _, ok := object(root["smartctl"]); !ok {
		return model.Sample{}, errInvalidOutput
	}

	device, ok := object(root["device"])

	if !ok {
		return model.Sample{}, errInvalidOutput
	}

	protocol := decodeProtocol(stringValue(device["protocol"]))
	identity, err := decodeIdentity(root)
	if err != nil {
		return model.Sample{}, errInvalidOutput
	}

	if protocol == model.ProtocolUnknown || !hasReadEvidence(root, protocol, identity) {
		return model.Sample{}, errInvalidOutput
	}

	sample := model.Sample{
		SchemaVersion: 1,
		SampledAt:     model.DateTime(sampledAt.UTC().Format(time.RFC3339Nano)),
		Protocol:      protocol,
		Identity:      identity,
		RotationRate:  decodeRotationRate(root, protocol),
		Health:        model.HealthUnknown,
		Counters:      make([]model.Counter, 0),
		Attributes:    make([]model.Attribute, 0),
	}

	if statusValue, exists := root["smart_status"]; exists {
		status, valid := object(statusValue)

		if !valid {
			return model.Sample{}, errInvalidOutput
		}

		if passedValue, exists := status["passed"]; exists {
			passed, valid := passedValue.(bool)

			if !valid {
				return model.Sample{}, errInvalidOutput
			}

			if passed {
				sample.Health = model.HealthPassed
			} else {
				sample.Health = model.HealthFailed
			}
		}
	}

	if err := decodeTemperature(root, protocol, &sample); err != nil {
		return model.Sample{}, errInvalidOutput
	}

	if err := decodePowerOnHours(root, protocol, &sample); err != nil {
		return model.Sample{}, errInvalidOutput
	}

	if protocol == model.ProtocolATA {
		if err := decodeATA(root, &sample); err != nil {
			return model.Sample{}, errInvalidOutput
		}
	}

	if protocol == model.ProtocolNVMe {
		if err := decodeNVMe(root, &sample); err != nil {
			return model.Sample{}, errInvalidOutput
		}
	}

	sample.Assessment = Assess(sample)

	return sample, nil
}

func Assess(sample model.Sample) model.Assessment {
	assessment := model.Assessment{Level: model.LevelNormal, Reasons: make([]model.Reason, 0), RulesVersion: 1}
	critical := false
	warning := false
	unknownHealth := sample.Health != model.HealthPassed && sample.Health != model.HealthFailed

	if sample.Health == model.HealthFailed {
		assessment.Reasons = append(assessment.Reasons, model.ReasonSmartHealthFailed)
		critical = true
	}

	for _, attribute := range sample.Attributes {
		if strings.EqualFold(strings.TrimSpace(attribute.WhenFailed), "now") {
			assessment.Reasons = append(assessment.Reasons, model.ReasonATACurrentThresholdFailure)
			critical = true

			break
		}
	}

	if unknownHealth {
		assessment.Reasons = append(assessment.Reasons, model.ReasonNoHealthData)
	}

	if value, ok := counterValue(sample.Counters, "critical_warning"); ok && positive(value) {
		assessment.Reasons = append(assessment.Reasons, model.ReasonNVMeCriticalWarning)
		warning = true
	}

	if sample.NVMeAvailableSpareThreshold != nil {
		spare, spareOK := counterValue(sample.Counters, "available_spare")
		threshold, thresholdOK := decimalInteger(*sample.NVMeAvailableSpareThreshold)

		if spareOK && thresholdOK {
			spareValue, spareValid := decimalInteger(spare)

			if spareValid && spareValue.Cmp(threshold) < 0 {
				assessment.Reasons = append(assessment.Reasons, model.ReasonNVMeSpareBelowThreshold)
				warning = true
			}
		}
	}

	if value, ok := counterValue(sample.Counters, "percentage_used"); ok && atLeast(value, "100") {
		assessment.Reasons = append(assessment.Reasons, model.ReasonNVMePercentageUsed)
		warning = true
	}

	if value, ok := counterValue(sample.Counters, "current_pending_sector_count"); ok && positive(value) {
		assessment.Reasons = append(assessment.Reasons, model.ReasonATAPendingSectors)
		warning = true
	}

	if value, ok := counterValue(sample.Counters, "offline_uncorrectable_sector_count"); ok && positive(value) {
		assessment.Reasons = append(assessment.Reasons, model.ReasonATAUncorrectableSectors)
		warning = true
	}

	switch {
	case critical:
		assessment.Level = model.LevelCritical
	case warning:
		assessment.Level = model.LevelWarning
	case unknownHealth:
		assessment.Level = model.LevelUnknown
	default:
		assessment.Level = model.LevelNormal
		assessment.Reasons = append(assessment.Reasons, model.ReasonNoApplicableWarning)
	}

	return assessment
}

func decodeProtocol(value string) model.Protocol {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "ata":
		return model.ProtocolATA
	case "nvme":
		return model.ProtocolNVMe
	case "scsi":
		return model.ProtocolSCSI
	default:
		return model.ProtocolUnknown
	}
}

func hasReadEvidence(root map[string]any, protocol model.Protocol, identity model.Identity) bool {
	if identity.Model != nil || identity.Serial != nil {
		return true
	}

	if _, exists := root["smart_status"]; exists {
		return true
	}

	switch protocol {
	case model.ProtocolATA:
		attributes, ok := object(root["ata_smart_attributes"])

		if !ok {
			return false
		}

		table, ok := attributes["table"].([]any)

		return ok && len(table) > 0
	case model.ProtocolNVMe:
		log, ok := object(root["nvme_smart_health_information_log"])

		if !ok {
			return false
		}

		for _, key := range []string{
			"critical_warning", "available_spare", "available_spare_threshold", "data_units_read", "data_units_read_s",
			"data_units_written", "data_units_written_s", "media_errors", "media_errors_s", "unsafe_shutdowns",
			"unsafe_shutdowns_s", "percentage_used", "temperature", "power_on_hours", "power_on_hours_s",
		} {
			if _, exists := log[key]; exists {
				return true
			}
		}

		return false
	case model.ProtocolSCSI:
		for _, key := range []string{"scsi_vendor", "scsi_product"} {
			if value, ok := root[key].(string); ok && strings.TrimSpace(value) != "" {
				return true
			}
		}

		for _, evidence := range []struct {
			key    string
			fields []string
		}{
			{key: "device_type", fields: []string{"scsi_value", "name"}},
			{key: "scsi_lb_provisioning", fields: []string{"value"}},
			{key: "smart_support", fields: []string{"available", "enabled"}},
			{key: "temperature", fields: []string{"current", "drive_trip"}},
		} {
			if value, ok := object(root[evidence.key]); ok {
				for _, field := range evidence.fields {
					if _, exists := value[field]; exists {
						return true
					}
				}
			}
		}
	}

	return false
}

func decodeIdentity(root map[string]any) (model.Identity, error) {
	modelName, err := printableField(root, "model_name")
	if err != nil {
		return model.Identity{}, err
	}

	if modelName == nil {
		modelName, err = printableField(root, "scsi_model_name")
		if err != nil {
			return model.Identity{}, err
		}
	}

	serial, err := printableField(root, "serial_number")
	if err != nil {
		return model.Identity{}, err
	}

	if _, err := printableField(root, "firmware_version"); err != nil {
		return model.Identity{}, err
	}

	identity := model.Identity{Model: modelTextPointer(modelName), Serial: modelTextPointer(serial)}

	if wwn, ok := object(root["wwn"]); ok {
		parts := make([]string, 0, 3)

		for _, key := range []string{"naa", "oui", "id"} {
			if value, exists := wwn[key]; exists {
				text, valid := decimalValue(value)

				if !valid {
					return model.Identity{}, errInvalidOutput
				}

				parts = append(parts, key+":"+text)
			}
		}

		if len(parts) > 0 {
			joined := strings.Join(parts, "/")
			identity.WWN = modelTextPointer(&joined)
		}
	}

	if capacity, ok := object(root["user_capacity"]); ok {
		if value, exists := capacity["bytes_s"]; exists {
			text, valid := decimalValue(value)

			if !valid {
				return model.Identity{}, errInvalidOutput
			}

			if len(text) <= 39 {
				identity.CapacityBytes = &text
			}
		} else if value, exists := capacity["bytes"]; exists {
			text, valid := decimalValue(value)

			if !valid {
				return model.Identity{}, errInvalidOutput
			}

			if len(text) <= 39 {
				identity.CapacityBytes = &text
			}
		}
	}

	return identity, nil
}

func decodeTemperature(root map[string]any, protocol model.Protocol, sample *model.Sample) error {
	var temperature any

	if value, exists := root["temperature"]; exists && value != nil {
		details, ok := object(value)

		if !ok {
			return errInvalidOutput
		}

		temperature = details["current"]
	}

	if protocol == model.ProtocolNVMe {
		if value, exists := root["nvme_smart_health_information_log"]; exists && value != nil {
			log, ok := object(value)

			if !ok {
				return errInvalidOutput
			}

			if logTemperature, exists := log["temperature"]; exists && logTemperature != nil {
				logValue, valid := numberValue(logTemperature)

				if !valid || math.IsNaN(logValue) || math.IsInf(logValue, 0) || logValue < -40 || logValue > 150 {
					return errInvalidOutput
				}

				if temperature == nil {
					temperature = logTemperature
				}
			}
		}
	}

	if temperature == nil {
		return nil
	}

	value, ok := numberValue(temperature)

	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < -40 || value > 150 {
		return errInvalidOutput
	}

	if protocol == model.ProtocolSCSI && value == 0 {
		if details, valid := object(root["temperature"]); valid {
			if trip, exists := details["drive_trip"]; exists {
				tripValue, valid := numberValue(trip)

				if !valid {
					return errInvalidOutput
				}

				if tripValue == 0 {
					return nil
				}
			}
		}
	}

	copy := value
	sample.TemperatureC = &copy
	sample.Capabilities.Temperature = true

	return nil
}

func decodePowerOnHours(root map[string]any, protocol model.Protocol, sample *model.Sample) error {
	var value any

	if details, ok := object(root["power_on_time"]); ok {
		value = details["hours"]
	}

	if value == nil && protocol == model.ProtocolNVMe {
		if log, ok := object(root["nvme_smart_health_information_log"]); ok {
			if exact, exists := log["power_on_hours_s"]; exists {
				value = exact
			} else {
				value = log["power_on_hours"]
			}
		}
	}

	if value == nil {
		return nil
	}

	text, valid := decimalValue(value)

	if !valid {
		return errInvalidOutput
	}

	if len(text) > 39 {
		return nil
	}

	sample.PowerOnHours = &text

	appendCounter(sample, "power_on_hours", text, "hours")

	return nil
}

func decodeATA(root map[string]any, sample *model.Sample) error {
	attributesRoot, exists := root["ata_smart_attributes"]

	if !exists {
		return nil
	}

	attributes, ok := object(attributesRoot)

	if !ok {
		return errInvalidOutput
	}

	tableValue, exists := attributes["table"]

	if !exists || tableValue == nil {
		return nil
	}

	table, ok := tableValue.([]any)

	if !ok {
		return errInvalidOutput
	}

	sample.Capabilities.Attributes = true

	rotationRate := float64(0)

	if value, exists := root["rotation_rate"]; exists {
		var valid bool
		rotationRate, valid = numberValue(value)

		if !valid || rotationRate < 0 {
			return errInvalidOutput
		}
	}

	for _, value := range table {
		item, valid := object(value)

		if !valid {
			return errInvalidOutput
		}

		attribute, id, err := decodeAttribute(item)
		if err != nil {
			return err
		}

		sample.Attributes = append(sample.Attributes, attribute)

		counterName, unit := ataCounterName(id, string(attribute.Name), rotationRate)

		if counterName == "" || attribute.Raw == nil || !validCounterDecimal(string(*attribute.Raw)) {
			continue
		}

		appendCounter(sample, counterName, string(*attribute.Raw), unit)
	}

	return nil
}

func decodeAttribute(item map[string]any) (model.Attribute, int, error) {
	attribute := model.Attribute{}
	id := 0

	if value, exists := item["id"]; exists {
		integer, valid := integerValue(value)

		if !valid || integer < 0 || integer > 255 {
			return model.Attribute{}, 0, errInvalidOutput
		}

		id = integer
		attribute.ID = &id
	}

	if name, ok := item["name"].(string); ok {
		attribute.Name = model.Text(name)
	}

	if value, exists := item["value"]; exists {
		number, valid := numberValue(value)

		if !valid {
			return model.Attribute{}, 0, errInvalidOutput
		}

		attribute.Normalized = &number
	}

	if value, exists := item["thresh"]; exists {
		number, valid := numberValue(value)

		if !valid {
			return model.Attribute{}, 0, errInvalidOutput
		}

		attribute.Threshold = &number
	}

	if value, exists := item["when_failed"]; exists {
		text, valid := value.(string)

		if !valid {
			return model.Attribute{}, 0, errInvalidOutput
		}

		attribute.WhenFailed = text
	}

	if rawValue, exists := item["raw"]; exists {
		raw, valid := object(rawValue)

		if !valid {
			return model.Attribute{}, 0, errInvalidOutput
		}

		if text, valid := raw["string"].(string); valid {
			attribute.Raw = modelTextPointer(&text)
		} else if value, exists := raw["value"]; exists {
			text, valid := decimalValue(value)

			if !valid {
				return model.Attribute{}, 0, errInvalidOutput
			}

			attribute.Raw = modelTextPointer(&text)
		}
	}

	return attribute, id, nil
}

func decodeNVMe(root map[string]any, sample *model.Sample) error {
	logValue, exists := root["nvme_smart_health_information_log"]

	if !exists {
		return nil
	}

	log, ok := object(logValue)

	if !ok {
		return errInvalidOutput
	}

	if value, exists := log["critical_warning"]; exists {
		integer, valid := integerValue(value)

		if !valid || integer < 0 || integer > 0x3f {
			return errInvalidOutput
		}

		appendCounter(sample, "critical_warning", strconv.Itoa(integer), "bitmask")
	}

	if value, exists := log["available_spare"]; exists {
		integer, valid := integerValue(value)

		if !valid || integer < 0 || integer > 100 {
			return errInvalidOutput
		}

		appendCounter(sample, "available_spare", strconv.Itoa(integer), "percent")
	}

	if value, exists := log["available_spare_threshold"]; exists {
		integer, valid := integerValue(value)

		if !valid || integer < 0 || integer > 100 {
			return errInvalidOutput
		}

		text := strconv.Itoa(integer)
		sample.NVMeAvailableSpareThreshold = &text
	}

	for _, counter := range []struct {
		field string
		name  string
		unit  string
	}{
		{field: "data_units_read", name: "data_units_read", unit: "data-units"},
		{field: "data_units_written", name: "data_units_written", unit: "data-units"},
		{field: "media_errors", name: "media_errors", unit: "errors"},
		{field: "unsafe_shutdowns", name: "unsafe_shutdowns", unit: "events"},
		{field: "percentage_used", name: "percentage_used", unit: "percent"},
	} {
		value, exists := log[counter.field]

		if !exists {
			continue
		}

		if exact, hasExact := log[counter.field+"_s"]; hasExact {
			value = exact
		}

		text, valid := decimalValue(value)

		if !valid {
			return errInvalidOutput
		}

		appendCounter(sample, counter.name, text, counter.unit)
	}

	return nil
}

func ataCounterName(id int, name string, rotationRate float64) (string, string) {
	normalized := normalizeAttributeName(name)

	switch id {
	case 5:
		if normalized == "reallocatedsectorct" || normalized == "reallocatedsectorcount" {
			return "reallocated_sector_count", "sectors"
		}
	case 197:
		if rotationRate > 0 && (normalized == "currentpendingsector" || normalized == "currentpendingsectorcount") {
			return "current_pending_sector_count", "sectors"
		}
	case 198:
		if rotationRate > 0 && (normalized == "offlineuncorrectable" || normalized == "offlineuncorrectablesectorcount") {
			return "offline_uncorrectable_sector_count", "sectors"
		}
	case 199:
		if normalized == "udmacrcerrorcount" {
			return "udma_crc_error_count", "errors"
		}
	}

	return "", ""
}

func normalizeAttributeName(value string) string {
	value = strings.ToLower(value)
	value = strings.NewReplacer("_", "", "-", "", " ", "").Replace(value)

	return value
}

func appendCounter(sample *model.Sample, name, value, unit string) {
	if len(value) > 39 {
		return
	}

	for _, counter := range sample.Counters {
		if string(counter.Name) == name {
			return
		}
	}

	if len(sample.Counters) >= model.MaxSampleCounters {
		return
	}

	sample.Counters = append(sample.Counters, model.Counter{Name: model.Text(name), Value: value, Unit: model.Text(unit)})
}

func counterValue(counters []model.Counter, name string) (string, bool) {
	for _, counter := range counters {
		if string(counter.Name) == name {
			return counter.Value, true
		}
	}

	return "", false
}

func positive(value string) bool {
	number, ok := decimalInteger(value)

	return ok && number.Sign() > 0
}

func atLeast(value, minimum string) bool {
	number, valueOK := decimalInteger(value)
	threshold, thresholdOK := decimalInteger(minimum)

	return valueOK && thresholdOK && number.Cmp(threshold) >= 0
}

func decimalInteger(value string) (*big.Int, bool) {
	if !validCounterDecimal(value) {
		return nil, false
	}

	number, ok := new(big.Int).SetString(value, 10)

	return number, ok
}

func validCounterDecimal(value string) bool {
	if value == "" {
		return false
	}

	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}

	return true
}

func object(value any) (map[string]any, bool) {
	result, ok := value.(map[string]any)

	return result, ok && result != nil
}

func stringValue(value any) string {
	result, _ := value.(string)

	return result
}

func printableField(root map[string]any, key string) (*string, error) {
	value, exists := root[key]

	if !exists || value == nil {
		return nil, nil
	}

	text, ok := value.(string)

	if !ok || !printableASCII(text) || len(text) > model.MaxDeviceStringBytes {
		return nil, errInvalidOutput
	}

	if text == "" {
		return nil, nil
	}

	return &text, nil
}

func printableASCII(value string) bool {
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return false
		}
	}

	return true
}

func decodeRotationRate(root map[string]any, protocol model.Protocol) *int {
	if protocol == model.ProtocolNVMe {
		return nil
	}

	value, exists := root["rotation_rate"]

	if !exists {
		return nil
	}

	number, ok := value.(json.Number)

	if !ok || !validCounterDecimal(number.String()) {
		return nil
	}

	rotationRate, err := strconv.Atoi(number.String())
	if err != nil || rotationRate > 100000 {
		return nil
	}

	return &rotationRate
}

func modelTextPointer(value *string) *model.Text {
	if value == nil {
		return nil
	}

	text := model.Text(*value)

	return &text
}

func decimalValue(value any) (string, bool) {
	var text string

	switch typed := value.(type) {
	case json.Number:
		text = typed.String()
	case string:
		text = typed
	default:
		return "", false
	}

	if !validCounterDecimal(text) {
		return "", false
	}

	return text, true
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		result, err := typed.Float64()

		return result, err == nil
	case string:
		result, err := strconv.ParseFloat(typed, 64)

		return result, err == nil
	default:
		return 0, false
	}
}

func integerValue(value any) (int, bool) {
	text, ok := decimalValue(value)

	if !ok {
		return 0, false
	}

	result, err := strconv.Atoi(text)

	return result, err == nil
}
