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

	"mndw.local/rrd"
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

func (s *ThermalSampler) Poll(_ context.Context) ([]rrd.Value, error) {
	if s.reader == nil {
		return []rrd.Value{rrd.Unknown}, errors.New("thermal reader is unavailable")
	}

	entries, err := s.reader.ReadDir(s.root)
	if err != nil {
		return []rrd.Value{rrd.Unknown}, fmt.Errorf("read thermal zones: %w", err)
	}

	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })

	type candidate struct {
		preferred bool
		value     rrd.Value
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
		candidates = append(candidates, candidate{preferred: typeErr == nil && preferred, value: rrd.Known(float64(milliCelsius))})
	}

	for _, candidate := range candidates {
		if candidate.preferred {
			return []rrd.Value{candidate.value}, nil
		}
	}

	if len(candidates) > 0 {
		return []rrd.Value{candidates[0].value}, firstErr
	}

	if firstErr == nil {
		firstErr = errors.New("no readable thermal zone")
	}

	return []rrd.Value{rrd.Unknown}, firstErr
}
