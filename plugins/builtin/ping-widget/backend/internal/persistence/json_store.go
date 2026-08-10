package persistence

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"mndw.local/shared/fsutil"

	"ping-widget/internal/config"
	"ping-widget/internal/model"
)

type JSONStore struct {
	stateDir  string
	hostsFile string
	statsFile string
}

func NewDefaultStore() *JSONStore {
	stateDir := resolveStateDir()
	return &JSONStore{
		stateDir:  stateDir,
		hostsFile: filepath.Join(stateDir, filepath.Base(config.HostsFile())),
		statsFile: filepath.Join(stateDir, filepath.Base(config.StatsFile())),
	}
}

func resolveStateDir() string {
	if err := os.MkdirAll(config.StateDir(), 0o755); err == nil {
		return config.StateDir()
	}

	return filepath.Join(os.TempDir(), "mndw", "ping-widget")
}

func (store *JSONStore) LoadHosts() ([]model.Host, error) {
	var hosts []model.Host
	if err := store.loadJSONWithBackup(store.hostsFile, &hosts); err != nil {
		return []model.Host{}, err
	}
	if hosts == nil {
		return []model.Host{}, nil
	}
	return hosts, nil
}

func (store *JSONStore) SaveHosts(hosts []model.Host) error {
	if hosts == nil {
		hosts = []model.Host{}
	}
	if err := os.MkdirAll(store.stateDir, 0o755); err != nil {
		return err
	}
	return fsutil.AtomicWriteJSON(store.hostsFile, hosts)
}

func (store *JSONStore) LoadStatsState() (map[string][]model.Sample, error) {
	samplesByHost := map[string][]model.Sample{}
	if err := store.loadJSONWithBackup(store.statsFile, &samplesByHost); err != nil {
		return map[string][]model.Sample{}, err
	}
	if samplesByHost == nil {
		return map[string][]model.Sample{}, nil
	}
	return samplesByHost, nil
}

func (store *JSONStore) SaveStatsState(samplesByHost map[string][]model.Sample) error {
	if samplesByHost == nil {
		samplesByHost = map[string][]model.Sample{}
	}
	if err := os.MkdirAll(store.stateDir, 0o755); err != nil {
		return err
	}
	return fsutil.AtomicWriteJSON(store.statsFile, samplesByHost)
}

func (store *JSONStore) loadJSONWithBackup(path string, destination any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	if len(data) == 0 {
		return nil
	}

	if err := json.Unmarshal(data, destination); err != nil {
		backupPath := filepath.Clean(path + ".bak")
		_ = os.Remove(backupPath)
		_ = os.Rename(path, backupPath)
		return nil
	}

	return nil
}
