package telemetry

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"mndwd/internal/telemetry/ring"
)

var legacyArtifactNames = []string{
	"mndw-load-v1.rrd",
	"mndw-temp-v1.rrd",
	"telemetry-derived.checkpoint",
	"telemetry-derived.clean",
}

// cleanupJournalArtifacts removes exact legacy journal and derived-output files.
func cleanupJournalArtifacts(fsys ring.FS, rrdDir string) error {
	if fsys == nil {
		return errors.New("telemetry: nil filesystem for legacy cleanup")
	}

	stagingDir := filepath.Join(rrdDir, "staging")
	entries, err := fsys.ReadDir(stagingDir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("read legacy staging directory: %w", err)
	}

	for _, entry := range entries {
		name := entry.Name()

		if entry.IsDir() || !isLegacyStagingArtifact(name) {
			continue
		}

		if err := removeIfPresent(fsys, filepath.Join(stagingDir, name)); err != nil {
			return fmt.Errorf("remove legacy staging artifact %q: %w", name, err)
		}
	}

	entries, err = fsys.ReadDir(stagingDir)
	if err == nil && len(entries) == 0 {
		if err := removeIfPresent(fsys, stagingDir); err != nil {
			return fmt.Errorf("remove empty legacy staging directory: %w", err)
		}
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("read legacy staging directory after cleanup: %w", err)
	}

	for _, name := range legacyArtifactNames {
		if err := removeIfPresent(fsys, filepath.Join(rrdDir, name)); err != nil {
			return fmt.Errorf("remove legacy artifact %q: %w", name, err)
		}
	}

	return nil
}

func isLegacyStagingArtifact(name string) bool {
	switch name {
	case "manifest.json", ".manifest.json.tmp", "journal.lock":
		return true
	default:
		return strings.HasPrefix(name, "seg-") && strings.HasSuffix(name, ".jnl")
	}
}

func removeIfPresent(fsys ring.FS, path string) error {
	if err := fsys.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	return nil
}
