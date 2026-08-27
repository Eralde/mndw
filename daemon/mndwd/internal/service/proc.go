package service

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	cmdlineReadLimit = 4096
	commReadLimit    = 64
	statusReadLimit  = 512
	entwareRoot      = "/opt"
)

type procRecord struct {
	pid     int
	cmdline string
	comm    string
	exe     string
	zombie  bool
}

func readProcSnapshot(ctx context.Context, procRoot string) ([]procRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil, err
	}

	records := make([]procRecord, 0, len(entries))

	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		pid, convErr := strconv.Atoi(entry.Name())

		if convErr != nil || pid <= 0 {
			continue
		}

		processDir := filepath.Join(procRoot, entry.Name())
		exe, readErr := os.Readlink(filepath.Join(processDir, "exe"))

		if readErr != nil {
			continue
		}

		cmdline, readErr := readProcValue(filepath.Join(processDir, "cmdline"), cmdlineReadLimit)

		if readErr != nil {
			continue
		}

		comm, readErr := readProcValue(filepath.Join(processDir, "comm"), commReadLimit)

		if readErr != nil {
			continue
		}

		status, readErr := readProcValue(filepath.Join(processDir, "status"), statusReadLimit)

		if readErr != nil {
			continue
		}

		if procStatusZombie(status) {
			continue
		}

		records = append(records, procRecord{
			pid:     pid,
			cmdline: strings.TrimSpace(strings.ReplaceAll(cmdline, "\x00", " ")),
			comm:    strings.TrimSpace(comm),
			exe:     strings.TrimSpace(exe),
		})
	}

	return records, nil
}

func readProcValue(path string, limit int) (string, error) {
	file, err := os.Open(path)

	if err != nil {
		return "", err
	}

	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, int64(limit)))

	if err != nil {
		return "", err
	}

	return string(data), nil
}

func procStatusZombie(status string) bool {
	for _, line := range strings.Split(status, "\n") {
		if !strings.HasPrefix(line, "State:") {
			continue
		}

		state := strings.TrimSpace(strings.TrimPrefix(line, "State:"))

		return len(state) > 0 && state[0] == 'Z'
	}

	return false
}

func (m *execManager) resolvePID(ctx context.Context, name, path string) (int, error) {
	return m.resolvePIDWithMeta(ctx, name, m.readScriptMeta(path))
}

func (m *execManager) resolvePIDWithMeta(ctx context.Context, name string, meta scriptMeta) (int, error) {
	records, err := m.procSnapshot(ctx)

	if err != nil {
		return 0, err
	}

	return resolveFromRecords(records, name, meta, m.pidFileDirs, m.pidfile), nil
}

func deriveProcessNames(name string) (fullName, serviceName, baseName string) {
	fullName = name

	if len(name) < 2 {
		return fullName, "", ""
	}

	serviceName = name[1:]
	baseName = strings.TrimLeft(serviceName, "0123456789")

	return fullName, serviceName, baseName
}

func resolveFromRecords(records []procRecord, name string, meta scriptMeta, pidFileDirs []string, mndwdPidfile string) int {
	records = optProcessRecords(records)

	live := make(map[int]struct{}, len(records))

	for _, record := range records {
		if record.pid > 0 && !record.zombie {
			live[record.pid] = struct{}{}
		}
	}

	for _, path := range pidFileCandidates(name, meta, pidFileDirs, mndwdPidfile) {
		pid, ok := readPidFile(path)

		if !ok || pid <= 0 {
			continue
		}

		if _, live := live[pid]; live {
			return pid
		}
	}

	_, _, baseName := deriveProcessNames(name)
	patterns := []string{meta.procs, meta.name, meta.daemon, baseName, name, filepath.Base(meta.script)}

	for _, pattern := range patterns {
		if pattern == "" || pattern == "." || pattern == "/" {
			continue
		}

		for _, variant := range commandLinePatternVariants(pattern) {
			if pid := lowestCmdlinePID(records, variant); pid != 0 {
				return pid
			}
		}
	}

	for _, pattern := range patterns {
		if pid := lowestCommPID(records, pattern); pid != 0 {
			return pid
		}
	}

	return 0
}

func optProcessRecords(records []procRecord) []procRecord {
	filtered := make([]procRecord, 0, len(records))

	for _, record := range records {
		if processExecutableUnder(record, entwareRoot) {
			filtered = append(filtered, record)
		}
	}

	return filtered
}

func processExecutableUnder(record procRecord, root string) bool {
	// Process names are shared with firmware services, so only binaries from
	// Entware's executable tree may satisfy an Entware init.d service.
	executable := strings.TrimSuffix(strings.TrimSpace(record.exe), " (deleted)")

	if executable == "" {
		return false
	}

	executable = filepath.Clean(executable)
	root = filepath.Clean(root)

	return executable == root || strings.HasPrefix(executable, root+string(filepath.Separator))
}

func pidFileCandidates(name string, meta scriptMeta, dirs []string, mndwdPidfile string) []string {
	candidates := make([]string, 0, 2+len(dirs)*4)

	if meta.pidFile != "" {
		candidates = append(candidates, meta.pidFile)
	} else if name == "S70mndwd" && mndwdPidfile != "" {
		candidates = append(candidates, mndwdPidfile)
	}

	fullName, _, baseName := deriveProcessNames(name)

	for _, dir := range dirs {
		for _, serviceName := range []string{baseName, fullName} {
			if serviceName == "" {
				continue
			}

			candidates = append(candidates,
				filepath.Join(dir, serviceName+".pid"),
				filepath.Join(dir, serviceName),
			)
		}
	}

	return candidates
}

func commandLinePatternVariants(pattern string) []string {
	pattern = strings.TrimSpace(pattern)

	if pattern == "" {
		return nil
	}

	variants := []string{pattern}

	if strings.Contains(pattern, "/") {
		base := filepath.Base(pattern)

		if base != pattern && base != "." && base != "/" {
			variants = append(variants, base)
		}
	}

	return variants
}

func lowestCmdlinePID(records []procRecord, pattern string) int {
	pattern = strings.ToLower(strings.TrimSpace(pattern))

	if pattern == "" {
		return 0
	}

	lowest := 0

	for _, record := range records {
		if record.pid <= 0 || record.zombie {
			continue
		}

		cmdline := strings.ToLower(strings.ReplaceAll(record.cmdline, "\x00", " "))

		if !strings.Contains(cmdline, pattern) {
			continue
		}

		if lowest == 0 || record.pid < lowest {
			lowest = record.pid
		}
	}

	return lowest
}

func lowestCommPID(records []procRecord, pattern string) int {
	want := truncateComm(filepath.Base(strings.TrimSpace(pattern)))

	if want == "" || want == "." || want == "/" {
		return 0
	}

	lowest := 0

	for _, record := range records {
		if record.pid <= 0 || record.zombie || truncateComm(strings.TrimSpace(record.comm)) != want {
			continue
		}

		if lowest == 0 || record.pid < lowest {
			lowest = record.pid
		}
	}

	return lowest
}

func truncateComm(value string) string {
	if len(value) > 15 {
		return value[:15]
	}

	return value
}
