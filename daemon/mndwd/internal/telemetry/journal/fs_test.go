package journal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"
)

// errInjected is the fault returned by a crashFS failpoint.
var errInjected = errors.New("journal: injected fault")

// crashFS models a filesystem whose unsynced content and unsynced directory
// names disappear when power is lost. A returned error alone is not a crash
// model, so Crash rewinds every file and name to its last synchronized state.
type crashFS struct {
	mu        sync.Mutex
	state     map[string][]byte
	durable   map[string][]byte
	dirs      map[string]bool
	failAfter map[string]int
	counts    map[string]int
	ops       []string
	tempSeq   int
}

// newCrashFS returns an in-memory filesystem with a crash model.
func newCrashFS(_ *testing.T) *crashFS {
	return &crashFS{
		state:     map[string][]byte{},
		durable:   map[string][]byte{},
		dirs:      map[string]bool{},
		failAfter: map[string]int{},
		counts:    map[string]int{},
	}
}

// FailAfter makes the next operation of this kind fail once it has already run
// n times.
func (fs *crashFS) FailAfter(operation string, n int) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	fs.failAfter[operation] = n
}

// Disarm removes a failpoint so later operations succeed.
func (fs *crashFS) Disarm(operation string) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	delete(fs.failAfter, operation)
}

// CountOf returns how many times an operation has run so far.
func (fs *crashFS) CountOf(operation string) int {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	return fs.counts[operation]
}

// Operations returns the recorded operation names in order.
func (fs *crashFS) Operations() []string {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	return append([]string(nil), fs.ops...)
}

// Crash discards everything that was not synchronized.
func (fs *crashFS) Crash() {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	fs.state = cloneState(fs.durable)
}

func cloneState(in map[string][]byte) map[string][]byte {
	out := make(map[string][]byte, len(in))

	for name, data := range in {
		out[name] = append([]byte(nil), data...)
	}

	return out
}

// record returns errInjected when the operation's failpoint is armed.
func (fs *crashFS) record(operation string) error {
	fs.ops = append(fs.ops, operation)
	fs.counts[operation]++

	if limit, ok := fs.failAfter[operation]; ok && fs.counts[operation] > limit {
		return fmt.Errorf("%w: %s", errInjected, operation)
	}

	return nil
}

func (fs *crashFS) OpenFile(name string, flag int, _ os.FileMode) (File, error) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("open"); err != nil {
		return nil, err
	}

	if flag&os.O_CREATE == 0 {
		if _, ok := fs.state[name]; !ok {
			return nil, &os.PathError{Op: "open", Path: name, Err: os.ErrNotExist}
		}
	} else if _, ok := fs.state[name]; !ok {
		fs.state[name] = nil
	}

	if flag&os.O_TRUNC != 0 {
		fs.state[name] = nil
	}

	return &crashFile{fs: fs, name: name}, nil
}

func (fs *crashFS) ReadFile(name string) ([]byte, error) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("readfile"); err != nil {
		return nil, err
	}

	data, ok := fs.state[name]

	if !ok {
		return nil, &os.PathError{Op: "read", Path: name, Err: os.ErrNotExist}
	}

	return append([]byte(nil), data...), nil
}

func (fs *crashFS) ReadDir(name string) ([]os.DirEntry, error) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("readdir"); err != nil {
		return nil, err
	}

	if !fs.dirs[name] {
		return nil, &os.PathError{Op: "readdir", Path: name, Err: os.ErrNotExist}
	}

	entries := make([]os.DirEntry, 0)

	for path := range fs.state {
		if filepath.Dir(path) != name {
			continue
		}

		entries = append(entries, crashDirEntry{name: filepath.Base(path)})
	}

	sortDirEntries(entries)

	return entries, nil
}

func (fs *crashFS) Rename(oldPath, newPath string) error {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("rename"); err != nil {
		return err
	}

	data, ok := fs.state[oldPath]

	if !ok {
		return &os.PathError{Op: "rename", Path: oldPath, Err: os.ErrNotExist}
	}

	fs.state[newPath] = data

	delete(fs.state, oldPath)

	return nil
}

func (fs *crashFS) Remove(name string) error {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("unlink"); err != nil {
		return err
	}

	if _, ok := fs.state[name]; !ok {
		return &os.PathError{Op: "remove", Path: name, Err: os.ErrNotExist}
	}

	delete(fs.state, name)

	return nil
}

func (fs *crashFS) MkdirAll(name string, _ os.FileMode) error {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("mkdir"); err != nil {
		return err
	}

	fs.dirs[name] = true

	return nil
}

func (fs *crashFS) MkdirTemp(dir, pattern string) (string, error) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("mkdirTemp"); err != nil {
		return "", err
	}

	fs.tempSeq++
	name := filepath.Join(dir, fmt.Sprintf("%s%d", pattern, fs.tempSeq))
	fs.dirs[name] = true

	return name, nil
}

func (fs *crashFS) Stat(name string) (os.FileInfo, error) {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("stat"); err != nil {
		return nil, err
	}

	if fs.dirs[name] {
		return crashFileInfo{name: filepath.Base(name), dir: true}, nil
	}

	data, ok := fs.state[name]

	if !ok {
		return nil, &os.PathError{Op: "stat", Path: name, Err: os.ErrNotExist}
	}

	return crashFileInfo{name: filepath.Base(name), size: int64(len(data))}, nil
}

func (fs *crashFS) SyncDir(name string) error {
	fs.mu.Lock()

	defer fs.mu.Unlock()

	if err := fs.record("syncdir"); err != nil {
		return err
	}

	fs.durable = cloneState(fs.state)

	return nil
}

// crashFile is an in-memory file handle.
type crashFile struct {
	fs     *crashFS
	name   string
	offset int64
	closed bool
}

func (f *crashFile) Read(p []byte) (int, error) {
	f.fs.mu.Lock()

	defer f.fs.mu.Unlock()

	if f.closed {
		return 0, os.ErrClosed
	}

	data := f.fs.state[f.name]

	if f.offset >= int64(len(data)) {
		return 0, io.EOF
	}

	n := copy(p, data[f.offset:])
	f.offset += int64(n)

	return n, nil
}

func (f *crashFile) Write(p []byte) (int, error) {
	f.fs.mu.Lock()

	defer f.fs.mu.Unlock()

	if err := f.fs.record("write"); err != nil {
		return 0, err
	}

	if f.closed {
		return 0, os.ErrClosed
	}

	data := f.fs.state[f.name]

	if int64(len(data)) < f.offset {
		gap := make([]byte, int(f.offset-int64(len(data))))
		data = append(data, gap...)
	}

	if int64(len(data)) == f.offset {
		data = append(data, p...)
	} else {
		data = append(data[:f.offset], append(append([]byte(nil), p...), data[f.offset:]...)...)
	}

	f.fs.state[f.name] = data
	f.offset += int64(len(p))

	return len(p), nil
}

func (f *crashFile) Seek(offset int64, whence int) (int64, error) {
	f.fs.mu.Lock()

	defer f.fs.mu.Unlock()

	size := int64(len(f.fs.state[f.name]))

	switch whence {
	case io.SeekStart:
		f.offset = offset
	case io.SeekCurrent:
		f.offset += offset
	case io.SeekEnd:
		f.offset = size + offset
	default:
		return 0, errors.New("journal: invalid whence")
	}

	return f.offset, nil
}

func (f *crashFile) Sync() error {
	f.fs.mu.Lock()

	defer f.fs.mu.Unlock()

	if err := f.fs.record("sync"); err != nil {
		return err
	}

	f.fs.durable[f.name] = append([]byte(nil), f.fs.state[f.name]...)

	return nil
}

func (f *crashFile) Truncate(size int64) error {
	f.fs.mu.Lock()

	defer f.fs.mu.Unlock()

	data := f.fs.state[f.name]

	if int64(len(data)) > size {
		data = data[:size]
	} else {
		data = append(data, make([]byte, int(size-int64(len(data))))...)
	}

	f.fs.state[f.name] = data

	return nil
}

func (f *crashFile) Close() error {
	f.fs.mu.Lock()

	defer f.fs.mu.Unlock()

	f.closed = true

	return nil
}

type crashDirEntry struct {
	name string
}

func (e crashDirEntry) Name() string               { return e.name }
func (e crashDirEntry) IsDir() bool                { return false }
func (e crashDirEntry) Type() os.FileMode          { return 0 }
func (e crashDirEntry) Info() (os.FileInfo, error) { return crashFileInfo{name: e.name}, nil }

type crashFileInfo struct {
	name string
	size int64
	dir  bool
}

func (i crashFileInfo) Name() string      { return i.name }
func (i crashFileInfo) Size() int64       { return i.size }
func (i crashFileInfo) Mode() os.FileMode { return 0o644 }
func (i crashFileInfo) ModTime() time.Time {
	return time.Time{}
}
func (i crashFileInfo) IsDir() bool { return i.dir }
func (i crashFileInfo) Sys() any    { return nil }

func sortDirEntries(entries []os.DirEntry) {
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
}

// fakeLocker records lock acquisitions and can fail a chosen mode.
type fakeLocker struct {
	mu       sync.Mutex
	calls    []LockMode
	fail     LockMode
	handles  int
	released int
}

func (l *fakeLocker) Acquire(_ context.Context, _ string, mode LockMode) (LockHandle, error) {
	l.mu.Lock()

	defer l.mu.Unlock()

	l.calls = append(l.calls, mode)

	if l.fail == mode {
		return nil, errInjected
	}

	l.handles++

	return &fakeLockHandle{locker: l}, nil
}

func (l *fakeLocker) Modes() []LockMode {
	l.mu.Lock()

	defer l.mu.Unlock()

	return append([]LockMode(nil), l.calls...)
}

func (l *fakeLocker) Released() int {
	l.mu.Lock()

	defer l.mu.Unlock()

	return l.released
}

type fakeLockHandle struct {
	locker   *fakeLocker
	released bool
}

func (h *fakeLockHandle) Close() error {
	h.locker.mu.Lock()

	defer h.locker.mu.Unlock()

	if h.released {
		return nil
	}

	h.released = true
	h.locker.released++

	return nil
}
