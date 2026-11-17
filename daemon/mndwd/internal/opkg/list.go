package opkg

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strings"
	"time"
)

func (m *execManager) ListInstalled(ctx context.Context) ([]string, error) {
	return m.list(ctx, "list-installed")
}

func (m *execManager) ListAvailable(ctx context.Context) ([]string, error) {
	return m.list(ctx, "list")
}

func (m *execManager) list(ctx context.Context, verb string) ([]string, error) {
	out, exitCode, err := m.run(ctx, "opkg", verb)
	if err != nil {
		m.logger.Error("opkg list failed", "verb", verb, "output", tailOutput(out))

		return nil, fmt.Errorf("opkg %s: %w", verb, err)
	}

	if exitCode != 0 {
		m.logger.Error("opkg list failed", "verb", verb, "output", tailOutput(out), "exitCode", exitCode)

		return nil, fmt.Errorf("opkg %s exited %d", verb, exitCode)
	}

	return parseNames(out), nil
}

func (m *execManager) List(ctx context.Context) (PackageList, error) {
	installedMap, installedErr := m.listMap(ctx, "list-installed")

	availableMap, availableErr := m.listMap(ctx, "list")

	if installedErr != nil && availableErr != nil {
		return PackageList{}, fmt.Errorf("opkg list-installed: %w; opkg list: %w", installedErr, availableErr)
	}

	combined := mergePackageMaps(installedMap, availableMap)
	metadataUpdatedAt, err := m.metadataUpdatedAt()
	if err != nil {
		return PackageList{}, err
	}

	return PackageList{Packages: combined, MetadataUpdatedAt: metadataUpdatedAt}, nil
}

func mergePackageMaps(installedMap, availableMap map[string]PackageEntry) []PackageEntry {
	combined := make([]PackageEntry, 0, len(installedMap)+len(availableMap))

	for name, available := range availableMap {
		installed, ok := installedMap[name]

		if !ok {
			available.Status = "available"
			combined = append(combined, available)

			continue
		}

		description := installed.Description

		if available.Description != "" {
			description = available.Description
		}

		entry := PackageEntry{
			Name:        name,
			Version:     installed.Version,
			Description: description,
			Status:      "installed",
		}

		if installed.Version != available.Version {
			entry.Status = "update_available"
			entry.NewVersion = available.Version
		}

		combined = append(combined, entry)
	}

	for name, installed := range installedMap {
		if _, ok := availableMap[name]; ok {
			continue
		}

		installed.Status = "installed"
		installed.NewVersion = ""
		combined = append(combined, installed)
	}

	slices.SortFunc(combined, func(left, right PackageEntry) int { return strings.Compare(left.Name, right.Name) })

	return combined
}

func (m *execManager) metadataUpdatedAt() (*time.Time, error) {
	m.defaults()

	entries, err := os.ReadDir(m.listsDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}

	if err != nil {
		return nil, fmt.Errorf("read opkg lists directory: %w", err)
	}

	var newest time.Time

	for _, entry := range entries {
		info, infoErr := entry.Info()

		if infoErr != nil || !info.Mode().IsRegular() {
			continue
		}

		modified := info.ModTime().UTC()

		if newest.IsZero() || modified.After(newest) {
			newest = modified
		}
	}

	if newest.IsZero() {
		return nil, nil
	}

	return &newest, nil
}

func (m *execManager) listMap(ctx context.Context, verb string) (map[string]PackageEntry, error) {
	out, exitCode, err := m.run(ctx, "opkg", verb)
	if err != nil {
		return nil, fmt.Errorf("opkg %s: %w", verb, err)
	}

	if exitCode != 0 {
		return nil, fmt.Errorf("opkg %s exited %d", verb, exitCode)
	}

	entries, err := parseEntries(out)
	if err != nil {
		return nil, err
	}

	result := make(map[string]PackageEntry, len(entries))

	for _, entry := range entries {
		result[entry.Name] = entry
	}

	return result, nil
}
