package diagnostics

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"smart-page/internal/model"
)

const maxProcessPIDs = 4096
const maxProcessDirectoryEntries = maxProcessPIDs + 64
const processDirectoryReadBatch = 128
const maxProcCommBytes = 64
const maxProcStatBytes = 4 * 1024

var errProcessViewLimit = errors.New("proc process view exceeds limit")
var errProcFieldTooLarge = errors.New("proc field exceeds size limit")

// ProcessReader exposes a bounded procfs view. ListPIDs returns an error rather than a partial result when its limits
// are exceeded. Comm removes exactly one trailing /proc newline; any preceding newline remains part of the name.
type ProcessReader interface {
	ListPIDs() ([]int, error)
	Comm(pid int) (string, error)
	ParentPID(pid int) (int, error)
}

type ProcReader struct {
	root string
}

func NewProcReader(root string) *ProcReader {
	return &ProcReader{root: root}
}

func (reader *ProcReader) ListPIDs() ([]int, error) {
	directory, err := os.Open(reader.root)
	if err != nil {
		return nil, err
	}

	defer directory.Close()

	return readPIDs(directory.ReadDir)
}

func (reader *ProcReader) Comm(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("invalid pid %d", pid)
	}

	data, err := readProcFile(filepath.Join(reader.root, strconv.Itoa(pid), "comm"), maxProcCommBytes)
	if err != nil {
		return "", err
	}

	return strings.TrimSuffix(string(data), "\n"), nil
}

func (reader *ProcReader) ParentPID(pid int) (int, error) {
	if pid <= 0 {
		return 0, fmt.Errorf("invalid pid %d", pid)
	}

	data, err := readProcFile(filepath.Join(reader.root, strconv.Itoa(pid), "stat"), maxProcStatBytes)
	if err != nil {
		return 0, err
	}

	return parseParentPID(string(data))
}

func readPIDs(readDir func(int) ([]os.DirEntry, error)) ([]int, error) {
	pids := make([]int, 0, maxProcessPIDs)
	entryCount := 0

	for {
		entries, err := readDir(processDirectoryReadBatch)

		for _, entry := range entries {
			entryCount++

			if entryCount > maxProcessDirectoryEntries {
				return nil, errProcessViewLimit
			}

			pid, parseErr := strconv.Atoi(entry.Name())

			if parseErr != nil || pid <= 0 {
				continue
			}

			if len(pids) == maxProcessPIDs {
				return nil, errProcessViewLimit
			}

			pids = append(pids, pid)
		}

		if errors.Is(err, io.EOF) {
			break
		}

		if err != nil {
			return nil, err
		}

		if len(entries) == 0 {
			break
		}
	}

	return pids, nil
}

func readProcFile(path string, maxBytes int) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, int64(maxBytes+1)))
	if err != nil {
		return nil, err
	}

	if len(data) > maxBytes {
		return nil, errProcFieldTooLarge
	}

	return data, nil
}

func parseParentPID(stat string) (int, error) {
	closeComm := strings.LastIndex(stat, ")")

	if closeComm < 0 {
		return 0, errors.New("invalid proc stat")
	}

	fields := strings.Fields(stat[closeComm+1:])

	if len(fields) < 2 {
		return 0, errors.New("incomplete proc stat")
	}

	parent, err := strconv.Atoi(fields[1])
	if err != nil || parent < 0 {
		return 0, errors.New("invalid proc stat parent pid")
	}

	return parent, nil
}

func Pending(now time.Time) model.Diagnostics {
	checkedAt := model.DateTime(now.UTC().Format(time.RFC3339))
	groups := make([]uint32, 0)
	reasons := make([]model.Text, 0)

	if groupIDs, err := os.Getgroups(); err == nil {
		for _, groupID := range groupIDs {
			groups = append(groups, uint32(groupID))
		}
	} else {
		reasons = append(reasons, "groups-unavailable")
	}

	return model.Diagnostics{
		CheckedAt: checkedAt,
		EUID:      uint32(os.Geteuid()),
		EGID:      uint32(os.Getegid()),
		Groups:    groups,
		Utility:   model.UtilityDiagnostic{},
		Smartd: model.SmartdDiagnostic{
			Status:    model.SmartdUnknown,
			CheckedAt: checkedAt,
		},
		Reasons: reasons,
	}
}

func Check(reader ProcessReader, ownPID int, now time.Time) model.Diagnostics {
	diagnostic := Pending(now)
	status, reason := detectSmartd(reader, ownPID)
	diagnostic.Smartd.Status = status
	diagnostic.Smartd.Reason = reason

	return diagnostic
}

func detectSmartd(reader ProcessReader, ownPID int) (model.SmartdStatus, *model.Text) {
	unknown := func(reason string) (model.SmartdStatus, *model.Text) {
		text := model.Text(reason)

		return model.SmartdUnknown, &text
	}

	if reader == nil {
		return unknown("process view unavailable")
	}

	pids, err := reader.ListPIDs()
	if err != nil {
		return unknown("process view unavailable")
	}

	if len(pids) > maxProcessPIDs {
		return unknown("process view incomplete")
	}

	parents := make(map[int]int, len(pids))
	comms := make(map[int]string, len(pids))
	incomplete := false
	ownPIDListed := false

	for _, pid := range pids {
		if pid <= 0 {
			incomplete = true

			continue
		}

		if pid == ownPID {
			ownPIDListed = true
		}

		parent, parentErr := reader.ParentPID(pid)
		comm, commErr := reader.Comm(pid)

		if errors.Is(parentErr, os.ErrNotExist) || errors.Is(commErr, os.ErrNotExist) {
			continue
		}

		if parentErr != nil || commErr != nil {
			incomplete = true

			continue
		}

		parents[pid] = parent
		comms[pid] = comm
	}

	if !ownPIDListed {
		incomplete = true
	}

	ancestors, ancestorsComplete := serviceAncestors(ownPID, parents)

	if !ancestorsComplete {
		incomplete = true
	}

	for pid, comm := range comms {
		if comm != "smartd" || pid == ownPID {
			continue
		}

		if _, isAncestor := ancestors[pid]; isAncestor {
			continue
		}

		descendant, validTree := processDescendsFrom(pid, ownPID, parents)

		if !validTree {
			incomplete = true

			continue
		}

		if !descendant {
			return model.SmartdDetected, nil
		}
	}

	if incomplete {
		return unknown("process view incomplete")
	}

	return model.SmartdNotDetected, nil
}

func serviceAncestors(ownPID int, parents map[int]int) (map[int]struct{}, bool) {
	ancestors := make(map[int]struct{})
	current := ownPID

	for range maxProcessPIDs {
		parent, exists := parents[current]

		if !exists || parent < 0 {
			return ancestors, false
		}

		if parent == 0 {
			return ancestors, true
		}

		if _, visited := ancestors[parent]; visited {
			return ancestors, false
		}

		ancestors[parent] = struct{}{}
		current = parent
	}

	return ancestors, false
}

func processDescendsFrom(pid int, ownPID int, parents map[int]int) (bool, bool) {
	current := pid

	for range maxProcessPIDs {
		parent, exists := parents[current]

		if !exists {
			return false, false
		}

		if parent == ownPID {
			return true, true
		}

		if parent < 0 {
			return false, false
		}

		if parent == 0 {
			return false, true
		}

		current = parent
	}

	return false, false
}
