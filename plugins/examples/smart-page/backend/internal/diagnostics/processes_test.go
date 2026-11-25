package diagnostics

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type processReaderStub struct {
	pids       []int
	comms      map[int]string
	parents    map[int]int
	listErr    error
	commErrs   map[int]error
	parentErrs map[int]error
}

func (reader *processReaderStub) ListPIDs() ([]int, error) {
	return reader.pids, reader.listErr
}

func (reader *processReaderStub) Comm(pid int) (string, error) {
	if err := reader.commErrs[pid]; err != nil {
		return "", err
	}

	comm, ok := reader.comms[pid]

	if !ok {
		return "", os.ErrNotExist
	}

	return comm, nil
}

func (reader *processReaderStub) ParentPID(pid int) (int, error) {
	if err := reader.parentErrs[pid]; err != nil {
		return 0, err
	}

	parent, ok := reader.parents[pid]

	if !ok {
		return 0, os.ErrNotExist
	}

	return parent, nil
}

func TestSmartdDetection(t *testing.T) {
	now := time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		reader *processReaderStub
		want   string
	}{
		{
			name: "helper is not smartd",
			reader: &processReaderStub{
				pids:    []int{1, 10, 11},
				comms:   map[int]string{1: "init", 10: "smart-page", 11: "smartd-helper"},
				parents: map[int]int{1: 0, 10: 1, 11: 10},
			},
			want: "not-detected",
		},
		{
			name: "own process tree is excluded",
			reader: &processReaderStub{
				pids:    []int{1, 10, 11},
				comms:   map[int]string{1: "init", 10: "smart-page", 11: "smartd"},
				parents: map[int]int{1: 0, 10: 1, 11: 10},
			},
			want: "not-detected",
		},
		{
			name: "service ancestor is excluded",
			reader: &processReaderStub{
				pids:    []int{1, 10},
				comms:   map[int]string{1: "smartd", 10: "smart-page"},
				parents: map[int]int{1: 0, 10: 1},
			},
			want: "not-detected",
		},
		{
			name: "external smartd is detected",
			reader: &processReaderStub{
				pids:    []int{1, 10, 11},
				comms:   map[int]string{1: "init", 10: "smart-page", 11: "smartd"},
				parents: map[int]int{1: 0, 10: 1, 11: 1},
			},
			want: "detected",
		},
		{
			name: "missing ancestry is unknown",
			reader: &processReaderStub{
				pids:    []int{10, 11},
				comms:   map[int]string{10: "smart-page", 11: "smartd"},
				parents: map[int]int{10: 1, 11: 99},
			},
			want: "unknown",
		},
		{
			name: "vanished pid is ignored",
			reader: &processReaderStub{
				pids:    []int{10, 11},
				comms:   map[int]string{10: "smart-page"},
				parents: map[int]int{10: 0},
			},
			want: "not-detected",
		},
		{
			name: "unreadable comm is unknown",
			reader: &processReaderStub{
				pids:     []int{10, 11},
				comms:    map[int]string{10: "smart-page"},
				parents:  map[int]int{10: 0, 11: 10},
				commErrs: map[int]error{11: os.ErrPermission},
			},
			want: "unknown",
		},
		{
			name: "unreadable parent is unknown",
			reader: &processReaderStub{
				pids:       []int{10, 11},
				comms:      map[int]string{10: "smart-page", 11: "other"},
				parents:    map[int]int{10: 0},
				parentErrs: map[int]error{11: os.ErrPermission},
			},
			want: "unknown",
		},
		{
			name: "unreadable process view is unknown",
			reader: &processReaderStub{
				listErr: errors.New("proc unavailable"),
			},
			want: "unknown",
		},
		{
			name: "missing own pid is unknown",
			reader: &processReaderStub{
				pids: []int{},
			},
			want: "unknown",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := Check(test.reader, 10, now)

			if string(got.Smartd.Status) != test.want {
				t.Fatalf("smartd status = %q, want %q", got.Smartd.Status, test.want)
			}

			if got.CheckedAt != "2026-11-24T12:00:00Z" || got.Smartd.CheckedAt != got.CheckedAt {
				t.Fatalf("check timestamps = %q and %q", got.CheckedAt, got.Smartd.CheckedAt)
			}

			if (test.want == "unknown") != (got.Smartd.Reason != nil) {
				t.Fatalf("smartd reason = %v, want reason only for unknown status", got.Smartd.Reason)
			}
		})
	}
}

func TestProcReaderParentPIDUsesStat(t *testing.T) {
	root := t.TempDir()
	processDir := filepath.Join(root, "314")

	if err := os.Mkdir(processDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(processDir, "stat"), []byte("314 (worker ) name) S 27 0 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(processDir, "cmdline"), []byte("314 99\x00"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(processDir, "comm"), []byte("smartd\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, process := range []struct {
		pid  string
		comm string
		stat string
	}{
		{pid: "1", comm: "init\n", stat: "1 (init) S 0 0 0"},
		{pid: "27", comm: "parent\n", stat: "27 (parent) S 0 0 0"},
		{pid: "999", comm: "smart-page\n", stat: "999 (smart-page) S 0 0 0"},
	} {
		processDir := filepath.Join(root, process.pid)

		if err := os.Mkdir(processDir, 0o755); err != nil {
			t.Fatal(err)
		}

		if err := os.WriteFile(filepath.Join(processDir, "comm"), []byte(process.comm), 0o600); err != nil {
			t.Fatal(err)
		}

		if err := os.WriteFile(filepath.Join(processDir, "stat"), []byte(process.stat), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	reader := NewProcReader(root)
	parent, err := reader.ParentPID(314)
	if err != nil {
		t.Fatalf("ParentPID() error = %v", err)
	}

	if parent != 27 {
		t.Fatalf("ParentPID() = %d, want stat PPID 27", parent)
	}

	comm, err := reader.Comm(314)
	if err != nil {
		t.Fatalf("Comm() error = %v", err)
	}

	if comm != "smartd\n" {
		t.Fatalf("Comm() = %q, want embedded newline preserved", comm)
	}

	got := Check(reader, 999, time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC))

	if got.Smartd.Status != "not-detected" {
		t.Fatalf("smartd status = %q, want not-detected for comm ending in two newlines", got.Smartd.Status)
	}
}

func TestProcReaderBounds(t *testing.T) {
	t.Run("pid cap", func(t *testing.T) {
		root := t.TempDir()

		for pid := 1; pid <= 4097; pid++ {
			if err := os.Mkdir(filepath.Join(root, strconv.Itoa(pid)), 0o755); err != nil {
				t.Fatal(err)
			}
		}

		reader := NewProcReader(root)

		if _, err := reader.ListPIDs(); err == nil {
			t.Fatal("ListPIDs() error = nil, want PID limit error")
		}

		got := Check(reader, 1, time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC))

		if got.Smartd.Status != "unknown" {
			t.Fatalf("smartd status = %q, want unknown for overflowing process view", got.Smartd.Status)
		}
	})

	for _, test := range []struct {
		name string
		comm string
		stat string
	}{
		{name: "comm overflow", comm: strings.Repeat("x", 65), stat: "10 (worker) S 0 0"},
		{name: "stat overflow", comm: "worker\n", stat: "10 (worker) S 0 " + strings.Repeat("x", 4097)},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			processDir := filepath.Join(root, "10")

			if err := os.Mkdir(processDir, 0o755); err != nil {
				t.Fatal(err)
			}

			if err := os.WriteFile(filepath.Join(processDir, "comm"), []byte(test.comm), 0o600); err != nil {
				t.Fatal(err)
			}

			if err := os.WriteFile(filepath.Join(processDir, "stat"), []byte(test.stat), 0o600); err != nil {
				t.Fatal(err)
			}

			got := Check(NewProcReader(root), 10, time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC))

			if got.Smartd.Status != "unknown" {
				t.Fatalf("smartd status = %q, want unknown for overflowing proc field", got.Smartd.Status)
			}
		})
	}
}
