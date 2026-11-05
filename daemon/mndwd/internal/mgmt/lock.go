package mgmt

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

const maxPluginLockBytes = 64 * 1024

// PluginLock is the host-facing version snapshot written by the CLI when it packs a plugin.
type PluginLock struct {
	SDKVersion         string            `json:"sdkVersion"`
	SharedDependencies map[string]string `json:"sharedDependencies"`
}

// readPluginLock reads an optional plugin lock. Invalid or oversized locks are ignored silently.
func readPluginLock(dir string) *PluginLock {
	file, err := os.Open(filepath.Join(dir, "mndw.lock.json"))
	if err != nil {
		return nil
	}

	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxPluginLockBytes+1))
	if err != nil || len(data) > maxPluginLockBytes {
		return nil
	}

	var fields map[string]json.RawMessage

	if err := json.Unmarshal(data, &fields); err != nil {
		return nil
	}

	lockVersionRaw, hasLockVersion := fields["lockVersion"]
	sdkVersionRaw, hasSDKVersion := fields["sdkVersion"]
	sharedDependenciesRaw, hasSharedDependencies := fields["sharedDependencies"]

	if !hasLockVersion || !hasSDKVersion || !hasSharedDependencies {
		return nil
	}

	var lockVersion int

	if err := json.Unmarshal(lockVersionRaw, &lockVersion); err != nil || lockVersion != 1 {
		return nil
	}

	sdkVersionRaw = bytes.TrimSpace(sdkVersionRaw)

	if len(sdkVersionRaw) == 0 || sdkVersionRaw[0] != '"' {
		return nil
	}

	var sdkVersion string

	if err := json.Unmarshal(sdkVersionRaw, &sdkVersion); err != nil {
		return nil
	}

	sharedDependenciesRaw = bytes.TrimSpace(sharedDependenciesRaw)

	if len(sharedDependenciesRaw) == 0 || sharedDependenciesRaw[0] != '{' {
		return nil
	}

	var sharedDependencies map[string]string

	if err := json.Unmarshal(sharedDependenciesRaw, &sharedDependencies); err != nil || sharedDependencies == nil {
		return nil
	}

	return &PluginLock{
		SDKVersion:         sdkVersion,
		SharedDependencies: sharedDependencies,
	}
}
