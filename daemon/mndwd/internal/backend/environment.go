package backend

import (
	"strconv"
	"strings"
)

type EnvironmentSpec struct {
	Path             string
	PluginID         string
	PluginDir        string
	PluginDataDir    string
	PluginRuntimeDir string
	BackendSocket    string
	ProtocolVersion  int
	RCISessionSocket string
	Service          bool
}

func BuildChildEnvironment(spec EnvironmentSpec) []string {
	env := []string{
		"PATH=" + spec.Path,
		"MNDW_PLUGIN_ID=" + spec.PluginID,
		"MNDW_PLUGIN_DIR=" + spec.PluginDir,
		"MNDW_PLUGIN_DATA_DIR=" + spec.PluginDataDir,
		"MNDW_PLUGIN_RUNTIME_DIR=" + spec.PluginRuntimeDir,
	}
	if spec.Service {
		env = append(env,
			"MNDW_BACKEND_SOCKET="+spec.BackendSocket,
			"MNDW_BACKEND_PROTOCOL="+strconv.Itoa(spec.ProtocolVersion),
		)
		if spec.RCISessionSocket != "" {
			env = append(env, "MNDW_RCI_SESSION_SOCKET="+spec.RCISessionSocket)
		}
	}

	return env
}

func EnvironmentValue(env []string, name string) (string, bool) {
	prefix := name + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix), true
		}
	}

	return "", false
}
