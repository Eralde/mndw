package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"mndwd/internal/backend"
)

func TestFindAssignmentValueRejectsDuplicates(t *testing.T) {
	for _, test := range []struct {
		name   string
		text   string
		prefix string
		suffix string
	}{
		{name: "config", text: "MNDWD_LIMIT=8\nMNDWD_LIMIT=4\n", prefix: "MNDWD_LIMIT="},
		{name: "shell", text: `: "${MNDWD_LIMIT:=8}"` + "\n" + `: "${MNDWD_LIMIT:=4}"` + "\n", prefix: `: "${MNDWD_LIMIT:=`, suffix: `}"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := findAssignmentValue(test.text, test.prefix, test.suffix); err == nil {
				t.Fatal("duplicate assignments were accepted")
			}
		})
	}
}

func findAssignmentValue(content string, prefix string, suffix string) (string, error) {
	count := 0
	value := ""

	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, prefix) && strings.HasSuffix(line, suffix) {
			count++
			value = strings.TrimSuffix(strings.TrimPrefix(line, prefix), suffix)
		}
	}

	if count != 1 {
		return "", errors.New("expected exactly one assignment")
	}

	return value, nil
}

func TestPackagingLimitsMatchBackendDefaults(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)

	if !ok {
		t.Fatal("runtime.Caller failed")
	}

	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
	initScript := filepath.Join(repoRoot, "build/packaging/init/S70mndwd")
	configFile := filepath.Join(repoRoot, "build/packaging/files/opt/etc/mndw.conf")
	limits := backend.DefaultLimits()
	defaults := []struct {
		name  string
		value int
	}{
		{name: "MNDWD_MAX_CONCURRENT_EXEC_TOTAL", value: limits.MaxConcurrentExecTotal},
		{name: "MNDWD_MAX_CONCURRENT_EXEC_PER_PLUGIN", value: limits.MaxConcurrentExecPerPlugin},
		{name: "MNDWD_MAX_SUPERVISED_SERVICES", value: limits.MaxSupervisedServices},
	}

	for _, item := range defaults {
		t.Run(item.name, func(t *testing.T) {
			if got := readShellDefault(t, initScript, item.name); got != item.value {
				t.Errorf("S70mndwd default for %s = %d, want %d", item.name, got, item.value)
			}

			if got := readConfigDefault(t, configFile, item.name); got != item.value {
				t.Errorf("mndw.conf default for %s = %d, want %d", item.name, got, item.value)
			}
		})
	}
}

func readShellDefault(t *testing.T, path string, name string) int {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shell init script: %v", err)
	}

	prefix := `: "${` + name + `:=`
	value, err := findAssignmentValue(string(content), prefix, `}"`)

	if err != nil {
		t.Fatalf("shell default for %s in %s: %v", name, path, err)
	}

	return parseDefaultInt(t, name, value)
}

func readConfigDefault(t *testing.T, path string, name string) int {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read mndw.conf: %v", err)
	}

	prefix := name + "="
	value, err := findAssignmentValue(string(content), prefix, "")

	if err != nil {
		t.Fatalf("config default for %s in %s: %v", name, path, err)
	}

	return parseDefaultInt(t, name, value)
}

func parseDefaultInt(t *testing.T, name string, value string) int {
	t.Helper()

	parsed, err := strconv.Atoi(value)
	if err != nil {
		t.Fatalf("parse default for %s: %v", name, err)
	}

	return parsed
}
