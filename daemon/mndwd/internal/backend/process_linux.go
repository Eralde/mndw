//go:build linux

package backend

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func readBootID() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")

	return strings.TrimSpace(string(data)), err
}

func ReadProcessIdentity(pid int) (ProcessIdentity, error) {
	statPath := filepath.Join("/proc", strconv.Itoa(pid), "stat")
	data, err := os.ReadFile(statPath)
	if err != nil {
		return ProcessIdentity{}, err
	}

	closeParen := strings.LastIndexByte(string(data), ')')

	if closeParen < 0 || closeParen+2 >= len(data) {
		return ProcessIdentity{}, fmt.Errorf("malformed process stat")
	}

	fields := strings.Fields(string(data)[closeParen+2:])

	if len(fields) <= 19 {
		return ProcessIdentity{}, fmt.Errorf("truncated process stat")
	}

	pgid, err := strconv.Atoi(fields[2])
	if err != nil {
		return ProcessIdentity{}, fmt.Errorf("parse process group: %w", err)
	}

	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return ProcessIdentity{}, fmt.Errorf("parse process start time: %w", err)
	}

	executablePath, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		return ProcessIdentity{}, err
	}

	info, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		return ProcessIdentity{}, err
	}

	device, inode := uint64(0), uint64(0)

	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		device = uint64(stat.Dev)
		inode = uint64(stat.Ino)
	}

	return ProcessIdentity{PID: pid, PGID: pgid, StartTimeTicks: start, ExecutablePath: executablePath, ExecutableDev: device, ExecutableIno: inode}, nil
}
