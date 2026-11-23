package main

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

func printPluginPackages(cfg Config, stdout, stderr io.Writer) error {
	snapshot, err := state.ReadOnly(cfg.StateFile())
	if err != nil {
		return fmt.Errorf("read plugin state: %w", err)
	}

	packages := make(map[string]map[string]struct{})

	for name, plugin := range snapshot.Plugins {
		if plugin.Source == state.SourceBuiltin || plugin.Approval != state.ApprovalApproved {
			continue
		}

		validated, err := manifest.Validate(plugin.Manifest)
		if err != nil {
			fmt.Fprintf(stderr, "mndwd: warning: skipping plugin %q with unreadable manifest: %v\n", name, err)

			continue
		}

		for _, packageName := range validated.Backend.Packages {
			if packages[packageName] == nil {
				packages[packageName] = make(map[string]struct{})
			}

			packages[packageName][validated.Name] = struct{}{}
		}
	}

	ordered := make([]string, 0, len(packages))

	for packageName := range packages {
		ordered = append(ordered, packageName)
	}

	sort.Strings(ordered)

	for _, packageName := range ordered {
		pluginNames := make([]string, 0, len(packages[packageName]))

		for pluginName := range packages[packageName] {
			pluginNames = append(pluginNames, pluginName)
		}

		sort.Strings(pluginNames)

		if _, err := fmt.Fprintf(stdout, "%s %s\n", packageName, strings.Join(pluginNames, ",")); err != nil {
			return fmt.Errorf("write plugin packages: %w", err)
		}
	}

	return nil
}
