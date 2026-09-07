package journal

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const (
	// manifestName is the journal manifest basename inside JournalDir.
	manifestName = "manifest.json"
	// manifestVersion is the only supported manifest version.
	manifestVersion = 1

	// stateInitializing marks a manifest whose one-time alpha cleanup has not
	// completed. Recovery finishes the cleanup rather than returning to it.
	stateInitializing = "initializing"
	// stateReady marks a manifest whose storage is usable.
	stateReady = "ready"
)

// legacyRRDBasenames are the only files the one-time alpha reset may remove
// from RRDDir. Annotation sidecars and new-format files are never touched.
var legacyRRDBasenames = []string{"mndw-load-v1.rrd", "mndw-temp-v1.rrd"}

// SegmentEntry is one committed segment file in the manifest inventory.
type SegmentEntry struct {
	Name          string `json:"name"`
	Boot          string `json:"boot"`
	SegmentID     uint64 `json:"segmentId,string"`
	BootOrder     uint64 `json:"bootOrder,string"`
	FirstSequence uint64 `json:"firstSequence,string"`
	Bytes         int64  `json:"bytes"`
	Sealed        bool   `json:"sealed"`
}

// Manifest is the authoritative journal inventory. It owns initialization
// state and the committed sequence-reservation ceiling.
type Manifest struct {
	Version         int            `json:"version"`
	State           string         `json:"state"`
	ReservedThrough uint64         `json:"reservedThrough,string"`
	Generation      uint64         `json:"generation,string"`
	Segments        []SegmentEntry `json:"segments"`
}

func manifestPath(paths StoragePaths) string {
	return filepath.Join(paths.JournalDir, manifestName)
}

func (m Manifest) validate() error {
	if m.Version != manifestVersion {
		return ErrUnsupported
	}
	if m.State != stateInitializing && m.State != stateReady {
		return validationError("unknown manifest state %q", m.State)
	}
	return nil
}

// loadManifest reads and validates the manifest. A missing file is reported as
// os.ErrNotExist so callers can distinguish a first run from damage.
func loadManifest(fs FileSystem, path string) (Manifest, error) {
	raw, err := fs.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Manifest{}, validationError("manifest is not readable: %v", err)
	}
	if err := manifest.validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// writeManifest replaces the manifest through write, file sync, atomic rename,
// and directory sync.
func writeManifest(fs FileSystem, path string, manifest Manifest) error {
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	return WriteFileAtomic(fs, path, data)
}

// WriteFileAtomic writes data to a sibling temporary file, synchronizes it,
// renames it over the target, and synchronizes the parent directory. It is the
// only replacement path for journal metadata and derived state.
func WriteFileAtomic(fs FileSystem, path string, data []byte) error {
	dir := filepath.Dir(path)
	temp := filepath.Join(dir, "."+filepath.Base(path)+".tmp")

	file, err := fs.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := fs.Rename(temp, path); err != nil {
		return err
	}
	return fs.SyncDir(dir)
}

// hasJournalArtifacts reports whether JournalDir already contains segment
// files. A missing manifest together with artifacts is a recovery failure, not
// a new installation.
func hasJournalArtifacts(fs FileSystem, paths StoragePaths) (bool, error) {
	entries, err := fs.ReadDir(paths.JournalDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return len(segmentNames(entries)) > 0, nil
}

// removeLegacyArtifacts removes the allowlisted legacy alpha RRD basenames from
// RRDDir. Missing files are not an error, and no other file is touched.
func removeLegacyArtifacts(fs FileSystem, paths StoragePaths) error {
	for _, name := range legacyRRDBasenames {
		target := filepath.Join(paths.RRDDir, name)
		if _, err := fs.Stat(target); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		if err := fs.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return fs.SyncDir(paths.RRDDir)
}

// initializeStorage performs the one-time alpha reset: record the
// `initializing` state, remove the allowlisted legacy files, then publish
// `ready`. It must not reset retained authoritative data for any other reason.
func initializeStorage(fs FileSystem, paths StoragePaths) (Manifest, error) {
	if err := fs.MkdirAll(paths.JournalDir, 0o755); err != nil {
		return Manifest{}, err
	}

	pending := Manifest{Version: manifestVersion, State: stateInitializing, Generation: 1}
	if err := writeManifest(fs, manifestPath(paths), pending); err != nil {
		return Manifest{}, err
	}
	if err := removeLegacyArtifacts(fs, paths); err != nil {
		return Manifest{}, err
	}

	pending.State = stateReady
	if err := writeManifest(fs, manifestPath(paths), pending); err != nil {
		return Manifest{}, err
	}
	return pending, nil
}
