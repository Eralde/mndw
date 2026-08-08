package backend

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type RuntimePaths struct {
	Root             string
	PluginID         string
	PluginDir        string
	BackendSocket    string
	RCISessionSocket string
	ServiceLease     string
}

func NewRuntimePaths(root, pluginID string) (RuntimePaths, error) {
	if root == "" {
		return RuntimePaths{}, fmt.Errorf("runtime root is required")
	}
	if pluginID == "" || pluginID == "." || pluginID == ".." || filepath.Base(pluginID) != pluginID || strings.ContainsAny(pluginID, `/\\`) {
		return RuntimePaths{}, fmt.Errorf("invalid plugin ID %q", pluginID)
	}

	pluginDir := filepath.Join(root, pluginID)

	return RuntimePaths{
		Root:             root,
		PluginID:         pluginID,
		PluginDir:        pluginDir,
		BackendSocket:    filepath.Join(pluginDir, "backend.sock"),
		RCISessionSocket: filepath.Join(pluginDir, "rci-session.sock"),
		ServiceLease:     filepath.Join(pluginDir, "service.lease"),
	}, nil
}

func (p RuntimePaths) Ensure() error {
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		return fmt.Errorf("create backend runtime root: %w", err)
	}
	if err := os.Chmod(p.Root, 0o700); err != nil {
		return fmt.Errorf("restrict backend runtime root: %w", err)
	}
	if err := os.MkdirAll(p.PluginDir, 0o700); err != nil {
		return fmt.Errorf("create backend runtime directory: %w", err)
	}
	if err := os.Chmod(p.PluginDir, 0o700); err != nil {
		return fmt.Errorf("restrict backend runtime directory: %w", err)
	}

	return nil
}
