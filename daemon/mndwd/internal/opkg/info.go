package opkg

import (
	"context"
	"fmt"
)

type PackageNotFoundError struct{ Name string }

func (e *PackageNotFoundError) Error() string { return "package not found: " + e.Name }

func (m *execManager) Info(ctx context.Context, name string) (PackageInfo, error) {
	m.defaults()

	if !pkgNameRe.MatchString(name) {
		return PackageInfo{}, &InvalidPackageError{Name: name}
	}

	out, exitCode, err := m.run(ctx, "opkg", "info", name)
	if err != nil {
		return PackageInfo{}, fmt.Errorf("opkg info: %w", err)
	}

	if exitCode != 0 {
		return PackageInfo{}, &PackageNotFoundError{Name: name}
	}

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		return PackageInfo{}, err
	}

	installedMap, _ := m.listMap(ctx, "list-installed")
	availableMap, _ := m.listMap(ctx, "list")
	installedVersion := ""

	if installed, ok := installedMap[name]; ok {
		installedVersion = installed.Version
	}

	selected, err := selectInfoBlock(blocks, name, installedVersion)
	if err != nil {
		return PackageInfo{}, err
	}

	info := PackageInfo{
		Name:         selected.Name,
		Version:      selected.Version,
		Description:  selected.Description,
		Size:         selected.Size,
		Dependencies: selected.Dependencies,
		Status:       derivePackageStatus(name, installedMap, availableMap),
	}
	statusOut, statusExit, statusErr := m.run(ctx, "opkg", "status", name)

	if statusErr == nil && statusExit == 0 {
		statusBlocks, parseErr := parseInfoBlocks(statusOut)

		if parseErr == nil {
			if statusBlock, findErr := selectInfoBlock(statusBlocks, name, installedVersion); findErr == nil {
				info.InstalledSize = statusBlock.InstalledSize
				info.InstalledTime = statusBlock.InstalledTime
			}
		}
	}

	return info, nil
}

func derivePackageStatus(name string, installedMap, availableMap map[string]PackageEntry) string {
	installed, installedOK := installedMap[name]
	available, availableOK := availableMap[name]

	if !installedOK {
		return "available"
	}

	if availableOK && installed.Version != available.Version {
		return "update_available"
	}

	return "installed"
}
