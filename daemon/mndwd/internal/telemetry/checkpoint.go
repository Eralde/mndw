package telemetry

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"mndwd/internal/telemetry/journal"
)

const (
	// checkpointMagic identifies the derived-state envelope.
	checkpointMagic = "MNDWCP01"
	// checkpointVersion is the only supported envelope version.
	checkpointVersion = 1
	// checkpointHeaderBytes is magic + version + kind + reserved + length.
	checkpointHeaderBytes = 16

	kindCheckpoint = 1
	kindClean      = 2

	// maxCheckpointPayload bounds one framed payload.
	maxCheckpointPayload = 64 << 10

	// cleanStateValid marks reusable derived files.
	cleanStateValid = "valid"
	// cleanStateInvalid marks derived files that must be rebuilt.
	cleanStateInvalid = "invalid"
)

var (
	// ErrCheckpointInvalid reports a framed derived-state file that cannot be
	// trusted: bad magic, version, kind, length, checksum, or payload.
	ErrCheckpointInvalid = errors.New("telemetry: derived checkpoint invalid")
	// ErrCheckpointAbsent reports a missing derived-state file.
	ErrCheckpointAbsent = errors.New("telemetry: derived checkpoint absent")
)

// frontierEntry is one series publication frontier in the checkpoint.
type frontierEntry struct {
	Series uint16 `json:"series"`
	SlotMs string `json:"slotMs"`
}

// fileEntry is one destination file identity in the checkpoint.
type fileEntry struct {
	Series            uint16 `json:"series"`
	Basename          string `json:"basename"`
	SchemaFingerprint string `json:"schemaFingerprint"`
	LastUpdateMs      string `json:"lastUpdateMs"`
	StatIdentity      string `json:"statIdentity"`
}

// checkpointPayload is the canonical checkpoint JSON payload.
type checkpointPayload struct {
	Version                    string
	Generation                 string
	JournalInventoryGeneration string
	PublicationThrough         string
	Frontiers                  []frontierEntry
	Files                      []fileEntry
}

// cleanPayload is the canonical clean-marker JSON payload.
type cleanPayload struct {
	State                      string
	CheckpointDigest           string
	JournalInventoryGeneration string
	FrontierDigest             string
}

// canonicalJSON encodes payloads with sorted keys, no insignificant
// whitespace, and decimal-integer spellings. Maps are marshalled with
// lexicographically sorted keys by encoding/json.
func canonicalCheckpointJSON(payload checkpointPayload) ([]byte, error) {
	frontiers := make([]any, 0, len(payload.Frontiers))
	for _, frontier := range payload.Frontiers {
		frontiers = append(frontiers, map[string]any{
			"series": frontier.Series,
			"slotMs": frontier.SlotMs,
		})
	}
	files := make([]any, 0, len(payload.Files))
	for _, file := range payload.Files {
		files = append(files, map[string]any{
			"series":            file.Series,
			"basename":          file.Basename,
			"schemaFingerprint": file.SchemaFingerprint,
			"lastUpdateMs":      file.LastUpdateMs,
			"statIdentity":      file.StatIdentity,
		})
	}

	document := map[string]any{
		"version":                    payload.Version,
		"generation":                 payload.Generation,
		"journalInventoryGeneration": payload.JournalInventoryGeneration,
		"publicationThrough":         payload.PublicationThrough,
		"frontiers":                  frontiers,
		"files":                      files,
	}
	return json.Marshal(document)
}

// canonicalCleanJSON encodes the clean marker payload canonically.
func canonicalCleanJSON(payload cleanPayload) ([]byte, error) {
	document := map[string]any{
		"state":                      payload.State,
		"checkpointDigest":           payload.CheckpointDigest,
		"journalInventoryGeneration": payload.JournalInventoryGeneration,
		"frontierDigest":             payload.FrontierDigest,
	}
	return json.Marshal(document)
}

// encodeFramed wraps a canonical payload in the MNDWCP01 envelope.
func encodeFramed(kind uint8, payload []byte) ([]byte, error) {
	if kind != kindCheckpoint && kind != kindClean {
		return nil, fmt.Errorf("%w: unknown kind %d", ErrCheckpointInvalid, kind)
	}
	if len(payload) > maxCheckpointPayload {
		return nil, fmt.Errorf("%w: payload %d exceeds %d", ErrCheckpointInvalid, len(payload), maxCheckpointPayload)
	}

	out := make([]byte, 0, checkpointHeaderBytes+len(payload)+4)
	out = append(out, checkpointMagic...)
	out = binary.LittleEndian.AppendUint16(out, checkpointVersion)
	out = append(out, kind, 0)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(payload)))
	out = append(out, payload...)
	sum := crc32.Update(0, crc32.MakeTable(crc32.Castagnoli), out)
	return binary.LittleEndian.AppendUint32(out, sum), nil
}

// decodeFramed validates and unwraps one framed payload.
func decodeFramed(raw []byte, kind uint8) ([]byte, error) {
	if len(raw) < checkpointHeaderBytes+4 {
		return nil, fmt.Errorf("%w: truncated", ErrCheckpointInvalid)
	}
	if string(raw[:8]) != checkpointMagic {
		return nil, fmt.Errorf("%w: bad magic", ErrCheckpointInvalid)
	}
	if version := binary.LittleEndian.Uint16(raw[8:]); version != checkpointVersion {
		return nil, fmt.Errorf("%w: version %d", ErrCheckpointInvalid, version)
	}
	if got := raw[10]; got != kind {
		return nil, fmt.Errorf("%w: kind %d", ErrCheckpointInvalid, got)
	}
	if raw[11] != 0 {
		return nil, fmt.Errorf("%w: reserved byte set", ErrCheckpointInvalid)
	}

	length := int(binary.LittleEndian.Uint32(raw[12:]))
	if length > maxCheckpointPayload || length+checkpointHeaderBytes+4 != len(raw) {
		return nil, fmt.Errorf("%w: length %d", ErrCheckpointInvalid, length)
	}

	body := raw[:checkpointHeaderBytes+length]
	sum := crc32.Update(0, crc32.MakeTable(crc32.Castagnoli), body)
	if stored := binary.LittleEndian.Uint32(raw[len(body):]); stored != sum {
		return nil, fmt.Errorf("%w: checksum", ErrCheckpointInvalid)
	}
	return raw[checkpointHeaderBytes : checkpointHeaderBytes+length], nil
}

// readFramedFile loads one framed derived-state file.
func readFramedFile(fs journal.FileSystem, path string, kind uint8) ([]byte, error) {
	raw, err := fs.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrCheckpointAbsent
		}
		return nil, err
	}
	return decodeFramed(raw, kind)
}

// writeFramedFile publishes one framed derived-state file atomically.
func writeFramedFile(fs journal.FileSystem, path string, kind uint8, payload []byte) error {
	framed, err := encodeFramed(kind, payload)
	if err != nil {
		return err
	}
	return journal.WriteFileAtomic(fs, path, framed)
}

// checkpointPaths returns the checkpoint and clean-marker paths.
func checkpointPaths(paths journal.StoragePaths) (checkpoint, clean string) {
	return filepath.Join(paths.RRDDir, "telemetry-derived.checkpoint"),
		filepath.Join(paths.RRDDir, "telemetry-derived.clean")
}

// tempSibling returns the dot-prefixed temporary name for a generation.
func tempSibling(path string, generation uint64) string {
	return filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+strconv.FormatUint(generation, 10)+".tmp")
}

// sha256Hex returns the lowercase hex digest of canonical bytes.
func sha256Hex(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// decodeCheckpointPayload validates canonical JSON and unknown keys.
func decodeCheckpointPayload(payload []byte) (checkpointPayload, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(payload, &document); err != nil {
		return checkpointPayload{}, fmt.Errorf("%w: not canonical json", ErrCheckpointInvalid)
	}

	allowed := map[string]bool{
		"version": true, "generation": true, "journalInventoryGeneration": true,
		"publicationThrough": true, "frontiers": true, "files": true,
	}
	for key := range document {
		if !allowed[key] {
			return checkpointPayload{}, fmt.Errorf("%w: unknown key %q", ErrCheckpointInvalid, key)
		}
	}

	var structure checkpointStructure
	if err := json.Unmarshal(payload, &structure); err != nil {
		return checkpointPayload{}, fmt.Errorf("%w: %v", ErrCheckpointInvalid, err)
	}

	// Re-encode and compare so noncanonical spellings are rejected.
	decoded := checkpointPayload{
		Version:                    structure.Version,
		Generation:                 structure.Generation,
		JournalInventoryGeneration: structure.JournalInventoryGeneration,
		PublicationThrough:         structure.PublicationThrough,
		Frontiers:                  structure.Frontiers,
		Files:                      structure.Files,
	}
	canonical, err := canonicalCheckpointJSON(decoded)
	if err != nil || !payloadsEqual(canonical, payload) {
		return checkpointPayload{}, fmt.Errorf("%w: noncanonical payload", ErrCheckpointInvalid)
	}
	return decoded, nil
}

// checkpointStructure is the typed shape of a canonical checkpoint payload.
type checkpointStructure struct {
	Version                    string          `json:"version"`
	Generation                 string          `json:"generation"`
	JournalInventoryGeneration string          `json:"journalInventoryGeneration"`
	PublicationThrough         string          `json:"publicationThrough"`
	Frontiers                  []frontierEntry `json:"frontiers"`
	Files                      []fileEntry     `json:"files"`
}

// frontierDigest canonicalizes frontiers for digest comparison.
func frontierDigest(frontiers []frontierEntry) (string, error) {
	sorted := append([]frontierEntry(nil), frontiers...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Series < sorted[j].Series })

	entries := make([]any, 0, len(sorted))
	for _, frontier := range sorted {
		entries = append(entries, map[string]any{"series": frontier.Series, "slotMs": frontier.SlotMs})
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		return "", err
	}
	return sha256Hex(encoded), nil
}

// payloadsEqual compares canonical payload bytes exactly.
func payloadsEqual(a, b []byte) bool { return bytes.Equal(a, b) }

// decodeCleanPayload validates canonical clean-marker JSON.
func decodeCleanPayload(payload []byte) (cleanPayload, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(payload, &document); err != nil {
		return cleanPayload{}, fmt.Errorf("%w: not canonical json", ErrCheckpointInvalid)
	}

	allowed := map[string]bool{
		"state": true, "checkpointDigest": true,
		"journalInventoryGeneration": true, "frontierDigest": true,
	}
	for key := range document {
		if !allowed[key] {
			return cleanPayload{}, fmt.Errorf("%w: unknown key %q", ErrCheckpointInvalid, key)
		}
	}

	var structure cleanStructure
	if err := json.Unmarshal(payload, &structure); err != nil {
		return cleanPayload{}, fmt.Errorf("%w: %v", ErrCheckpointInvalid, err)
	}

	decoded := cleanPayload{
		State:                      structure.State,
		CheckpointDigest:           structure.CheckpointDigest,
		JournalInventoryGeneration: structure.JournalInventoryGeneration,
		FrontierDigest:             structure.FrontierDigest,
	}
	canonical, err := canonicalCleanJSON(decoded)
	if err != nil || !payloadsEqual(canonical, payload) {
		return cleanPayload{}, fmt.Errorf("%w: noncanonical payload", ErrCheckpointInvalid)
	}
	if decoded.State != cleanStateValid && decoded.State != cleanStateInvalid {
		return cleanPayload{}, fmt.Errorf("%w: state %q", ErrCheckpointInvalid, decoded.State)
	}
	return decoded, nil
}

// cleanStructure is the typed shape of a canonical clean-marker payload.
type cleanStructure struct {
	State                      string `json:"state"`
	CheckpointDigest           string `json:"checkpointDigest"`
	JournalInventoryGeneration string `json:"journalInventoryGeneration"`
	FrontierDigest             string `json:"frontierDigest"`
}
