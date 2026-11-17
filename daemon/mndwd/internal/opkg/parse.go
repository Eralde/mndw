package opkg

import (
	"fmt"
	"regexp"
	"strings"
)

// dependentsRe matches the header line opkg prints when a removal is refused because
// other installed packages depend on the target, e.g.:
//
//	Package curl is depended upon by packages:
var dependentsRe = regexp.MustCompile(`Package\s+(\S+)\s+is depended upon by packages`)

// errorLabelRe matches the C function-name label opkg prepends to each collected-error
// line, e.g. "print_dependents_warning: ". It is stripped so the actual message
// content is parsed rather than the label.
var errorLabelRe = regexp.MustCompile(`^[a-z][a-z0-9_]*:\s*`)

// cleanOpkgLine strips opkg's collected-error decoration from a single line: the
// leading " * " bullet and the "<function>: " label (which the device's opkg prepends
// to every line of the warning, dependent names included), leaving the bare content.
func cleanOpkgLine(raw string) string {
	line := strings.TrimSpace(raw)
	line = strings.TrimSpace(strings.TrimPrefix(line, "*"))
	line = errorLabelRe.ReplaceAllString(line, "")

	return strings.TrimSpace(line)
}

// detectDependents scans opkg remove output for the reverse-dependency warning and
// returns a DependencyConflictError when present. The dependent names follow the
// header on their own lines (each carrying opkg's " * <function>: " decoration) until
// the "These might cease to work" / "Force removal" advisory lines.
func detectDependents(out string) *DependencyConflictError {
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")

	for i, raw := range lines {
		match := dependentsRe.FindStringSubmatch(cleanOpkgLine(raw))

		if match == nil {
			continue
		}

		conflict := &DependencyConflictError{Package: match[1]}

		for _, follow := range lines[i+1:] {
			text := cleanOpkgLine(follow)

			if text == "" {
				continue
			}

			if strings.HasPrefix(text, "These might cease to work") ||
				strings.HasPrefix(text, "Force removal") ||
				dependentsRe.MatchString(text) {
				break
			}

			conflict.DependedBy = append(conflict.DependedBy, strings.Fields(text)[0])
		}

		return conflict
	}

	return nil
}

type packageInfoBlock struct {
	Name          string
	Version       string
	Description   string
	Size          string
	Dependencies  []string
	InstalledSize string
	InstalledTime string
}

func isArchitectureWarning(line string) bool {
	return strings.HasPrefix(line, "Package ") && strings.HasSuffix(line, " has no valid architecture, ignoring.")
}

func parseInfoBlocks(out string) ([]packageInfoBlock, error) {
	blocks := make([]packageInfoBlock, 0)

	for _, rawBlock := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n\n") {
		blockText := strings.TrimSpace(rawBlock)

		if blockText == "" {
			continue
		}

		block := packageInfoBlock{Dependencies: []string{}}
		lastField := ""

		for _, line := range strings.Split(blockText, "\n") {
			rawLine := strings.TrimRight(line, "\r")
			line = strings.TrimSpace(rawLine)

			if line == "" {
				continue
			}

			key, value, ok := strings.Cut(line, ":")

			if !ok {
				// A line without a colon is a continuation of the previous
				// field: either a wrapped Description line, or an entry in a
				// multi-valued field such as Conffiles (a path plus checksum).
				if lastField == "Description" {
					if block.Description != "" {
						block.Description += "\n"
					}

					block.Description += line
				}

				continue
			}

			lastField = strings.TrimSpace(key)
			value = strings.TrimSpace(value)

			switch lastField {
			case "Package":
				block.Name = value
			case "Version":
				block.Version = value
			case "Description":
				block.Description = value
			case "Size":
				block.Size = value
			case "Depends":
				if value != "" {
					for _, dependency := range strings.Split(value, ",") {
						block.Dependencies = append(block.Dependencies, strings.TrimSpace(dependency))
					}
				}
			case "Installed-Size":
				block.InstalledSize = value
			case "Installed-Time":
				block.InstalledTime = value
			}
		}

		if block.Name == "" || block.Version == "" {
			return nil, fmt.Errorf("malformed opkg info block: missing package or version")
		}

		blocks = append(blocks, block)
	}

	return blocks, nil
}

func selectInfoBlock(blocks []packageInfoBlock, name, installedVersion string) (packageInfoBlock, error) {
	for _, block := range blocks {
		if block.Name == name && installedVersion != "" && block.Version == installedVersion {
			return block, nil
		}
	}

	for _, block := range blocks {
		if block.Name == name {
			return block, nil
		}
	}

	return packageInfoBlock{}, &PackageNotFoundError{Name: name}
}

// parseNames extracts the first whitespace field of each non-empty line, the package
// name in `opkg list` / `opkg list-installed` output ("name - version - desc").
func parseNames(out string) []string {
	names := make([]string, 0)

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)

		if line == "" || isArchitectureWarning(line) {
			continue
		}

		fields := strings.Fields(line)

		if len(fields) == 0 {
			continue
		}

		names = append(names, fields[0])
	}

	return names
}

func parseEntries(out string) ([]PackageEntry, error) {
	entries := make([]PackageEntry, 0)

	for i, rawLine := range strings.Split(out, "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		trimmedLine := strings.TrimSpace(line)

		if trimmedLine == "" || isArchitectureWarning(trimmedLine) {
			continue
		}

		parts := strings.SplitN(line, " - ", 3)

		if len(parts) < 2 {
			return nil, fmt.Errorf("malformed opkg output line %d: %q", i+1, strings.TrimSpace(line))
		}

		name := strings.TrimSpace(parts[0])
		version := strings.TrimSpace(parts[1])

		if name == "" || version == "" {
			return nil, fmt.Errorf("malformed opkg output line %d: %q", i+1, strings.TrimSpace(line))
		}

		description := ""

		if len(parts) >= 3 {
			description = strings.TrimSpace(parts[2])
		}

		entries = append(entries, PackageEntry{
			Name:        name,
			Version:     version,
			Description: description,
		})
	}

	return entries, nil
}
