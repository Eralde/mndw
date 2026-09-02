package deviceinfo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"strings"
)

type parsedPort struct {
	port Switchport
}

func parseConstants(data []byte) (Snapshot, error) {
	var document json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(data))

	if err := decoder.Decode(&document); err != nil {
		return Snapshot{}, fmt.Errorf("decode ndmConstants.json: %w", err)
	}

	var trailing json.RawMessage

	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return Snapshot{}, fmt.Errorf("decode ndmConstants.json: trailing JSON data")
		}

		return Snapshot{}, fmt.Errorf("decode ndmConstants.json: %w", err)
	}

	snapshot := emptySnapshot()
	var sections map[string]json.RawMessage

	if err := json.Unmarshal(document, &sections); err != nil {
		return snapshot, nil
	}

	parsePortMap(sections["PORTS_MAP"], &snapshot)
	parseLayout(sections["PORTS_LAYOUT"], &snapshot)

	snapshot.USBPortCount = parseOptionalNonNegativeInt(sections["USB_PORTS_NUMBER"])
	snapshot.Switchports.HasPortStats = parseOptionalBool(sections["HAS_PORTS_STAT"])

	return snapshot, nil
}

func parsePortMap(raw json.RawMessage, snapshot *Snapshot) {
	var entries map[string]json.RawMessage

	if len(raw) == 0 || json.Unmarshal(raw, &entries) != nil {
		return
	}

	parsed := make([]parsedPort, 0, len(entries))

	for id, rawEntry := range entries {
		if id == "" {
			continue
		}

		var entry map[string]json.RawMessage

		if json.Unmarshal(rawEntry, &entry) != nil {
			continue
		}

		index, ok := parseRequiredNonNegativeInt(entry["index"])

		if !ok {
			slog.Debug("skipping device port with invalid index", "id", id)

			continue
		}

		label := firstNonEmpty(stringField(entry, "name"), stringField(entry, "port"), id)
		parsed = append(parsed, parsedPort{port: Switchport{
			ID:          id,
			Label:       label,
			Index:       index,
			Type:        stringField(entry, "type"),
			Group:       stringField(entry, "group"),
			Color:       stringField(entry, "color"),
			InterfaceID: stringField(entry, "interfaceId"),
		}})
	}

	sort.Slice(parsed, func(i, j int) bool {
		if parsed[i].port.Index != parsed[j].port.Index {
			return parsed[i].port.Index < parsed[j].port.Index
		}

		return parsed[i].port.ID < parsed[j].port.ID
	})

	for _, candidate := range parsed {
		if len(snapshot.Switchports.List) > 0 && snapshot.Switchports.List[len(snapshot.Switchports.List)-1].Index == candidate.port.Index {
			slog.Debug("skipping duplicate device port index", "id", candidate.port.ID, "index", candidate.port.Index)

			continue
		}

		snapshot.Switchports.List = append(snapshot.Switchports.List, candidate.port)
	}
}

func parseLayout(raw json.RawMessage, snapshot *Snapshot) {
	var rows []json.RawMessage

	if len(raw) == 0 || json.Unmarshal(raw, &rows) != nil {
		return
	}

	for _, rawRow := range rows {
		var row []string

		if json.Unmarshal(rawRow, &row) == nil {
			snapshot.Switchports.Layout = append(snapshot.Switchports.Layout, row)
		}
	}
}

func stringField(entry map[string]json.RawMessage, key string) string {
	var value string

	if json.Unmarshal(entry[key], &value) != nil {
		return ""
	}

	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}

	return ""
}

func parseOptionalBool(raw json.RawMessage) bool {
	var value bool

	if json.Unmarshal(raw, &value) != nil {
		return false
	}

	return value
}

func parseOptionalNonNegativeInt(raw json.RawMessage) int {
	value, ok := parseRequiredNonNegativeInt(raw)

	if !ok {
		return 0
	}

	return value
}

func parseRequiredNonNegativeInt(raw json.RawMessage) (int, bool) {
	if len(raw) == 0 {
		return 0, false
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))

	decoder.UseNumber()

	var value any

	if err := decoder.Decode(&value); err != nil {
		return 0, false
	}

	var text string

	switch typed := value.(type) {
	case json.Number:
		text = typed.String()
	case string:
		text = typed
	default:
		return 0, false
	}

	text = strings.TrimSpace(text)

	if text == "" {
		return 0, false
	}

	if value, err := strconv.ParseInt(text, 10, 64); err == nil && value >= 0 {
		if uint64(value) <= uint64(maxInt()) {
			return int(value), true
		}
	}

	floatValue, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(floatValue) || math.IsInf(floatValue, 0) || floatValue < 0 || math.Trunc(floatValue) != floatValue {
		return 0, false
	}

	if floatValue > float64(maxInt()) {
		return 0, false
	}

	return int(floatValue), true
}

func maxInt() int {
	return int(^uint(0) >> 1)
}
