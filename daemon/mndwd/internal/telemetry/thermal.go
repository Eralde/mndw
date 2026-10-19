package telemetry

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type ThermalReader interface {
	ReadDir(string) ([]fs.DirEntry, error)
	ReadFile(string) ([]byte, error)
}

type ThermalSampler struct {
	reader ThermalReader
	root   string
}

func NewThermalSampler(reader ThermalReader, root string) *ThermalSampler {
	return &ThermalSampler{reader: reader, root: root}
}

// Supported probes sensor presence independently of measurement validity.
// A present sensor with a read error remains supported but produces unknown data.
func (s *ThermalSampler) Supported() bool {
	if s.reader == nil {
		return false
	}

	entries, err := s.reader.ReadDir(s.root)
	if err != nil {
		// Only absence proves lack of support; transient failures are unknown data.
		return !errors.Is(err, fs.ErrNotExist)
	}

	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "thermal_zone") {
			continue
		}

		_, err := s.reader.ReadFile(filepath.Join(s.root, entry.Name(), "temp"))
		if !errors.Is(err, fs.ErrNotExist) {
			return true
		}
	}

	return false
}

func (s *ThermalSampler) Poll(_ context.Context) ([]Value, error) {
	if s.reader == nil {
		return []Value{{}}, errors.New("thermal reader is unavailable")
	}

	entries, err := s.reader.ReadDir(s.root)
	if err != nil {
		return []Value{{}}, fmt.Errorf("read thermal zones: %w", err)
	}

	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })

	type candidate struct {
		preferred bool
		value     Value
	}

	var candidates []candidate
	var firstErr error

	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "thermal_zone") {
			continue
		}

		rawType, typeErr := s.reader.ReadFile(filepath.Join(s.root, entry.Name(), "type"))
		rawTemp, tempErr := s.reader.ReadFile(filepath.Join(s.root, entry.Name(), "temp"))

		if tempErr != nil {
			if firstErr == nil {
				firstErr = tempErr
			}

			continue
		}

		milliCelsius, parseErr := strconv.ParseInt(strings.TrimSpace(string(rawTemp)), 10, 64)

		if parseErr != nil || milliCelsius < -100000 || milliCelsius > 250000 {
			if firstErr == nil {
				firstErr = fmt.Errorf("invalid temperature in %s", entry.Name())
			}

			continue
		}

		typeName := strings.ToLower(strings.TrimSpace(string(rawType)))
		preferred := strings.Contains(typeName, "cpu") || strings.Contains(typeName, "soc") || strings.Contains(typeName, "processor")
		candidates = append(candidates, candidate{preferred: typeErr == nil && preferred, value: Value{Known: true, V: float64(milliCelsius)}})
	}

	for _, candidate := range candidates {
		if candidate.preferred {
			return []Value{candidate.value}, nil
		}
	}

	if len(candidates) > 0 {
		return []Value{candidates[0].value}, firstErr
	}

	if firstErr == nil {
		firstErr = errors.New("no readable thermal zone")
	}

	return []Value{{}}, firstErr
}
