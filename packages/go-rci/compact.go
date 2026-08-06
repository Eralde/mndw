package rci

import "encoding/json"

type compactedQueries struct {
	wire      [][]byte
	positions [][]int
}

func compactQueries(queries []Query) (compactedQueries, error) {
	wireQueries := make([][]byte, len(queries))
	for index, query := range queries {
		wire, err := marshalQuery(query)
		if err != nil {
			return compactedQueries{}, err
		}
		wireQueries[index] = wire
	}
	return compactWireQueries(wireQueries), nil
}

func compactWireQueries(wireQueries [][]byte) compactedQueries {
	compacted := compactedQueries{
		wire:      make([][]byte, 0, len(wireQueries)),
		positions: make([][]int, 0, len(wireQueries)),
	}
	lookup := make(map[string]int, len(wireQueries))

	for inputIndex, wire := range wireQueries {
		key := string(wire)
		uniqueIndex, ok := lookup[key]
		if !ok {
			lookup[key] = len(compacted.wire)
			compacted.wire = append(compacted.wire, wire)
			compacted.positions = append(compacted.positions, []int{inputIndex})
			continue
		}
		compacted.positions[uniqueIndex] = append(compacted.positions[uniqueIndex], inputIndex)
	}

	return compacted
}

func inflateResults(uniqueResults []json.RawMessage, positions [][]int, inputLen int) []json.RawMessage {
	results := make([]json.RawMessage, inputLen)
	for uniqueIndex, inputPositions := range positions {
		if uniqueIndex >= len(uniqueResults) || uniqueResults[uniqueIndex] == nil {
			continue
		}
		for _, inputIndex := range inputPositions {
			if inputIndex < 0 || inputIndex >= len(results) {
				continue
			}
			results[inputIndex] = append(json.RawMessage(nil), uniqueResults[uniqueIndex]...)
		}
	}
	return results
}
