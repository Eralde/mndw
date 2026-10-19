package persistence

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

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

	return store.atomicWriteJSON(store.hostsFile, hosts)
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

	return store.atomicWriteJSON(store.statsFile, samplesByHost)
}

func (store *JSONStore) atomicWriteJSON(targetPath string, value any) error {
	if err := os.MkdirAll(store.stateDir, 0o755); err != nil {
		return err
	}

	data, err := json.Marshal(value)
	if err != nil {
		return err
	}

	tempFile, err := os.CreateTemp(store.stateDir, "write-*.json")
	if err != nil {
		return err
	}

	tempPath := tempFile.Name()
	cleanup := true

	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err = tempFile.Write(data); err != nil {
		_ = tempFile.Close()

		return err
	}

	if err = tempFile.Sync(); err != nil {
		_ = tempFile.Close()

		return err
	}

	if err = tempFile.Close(); err != nil {
		return err
	}

	if err = os.Rename(tempPath, targetPath); err != nil {
		return err
	}

	cleanup = false

	return nil
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
