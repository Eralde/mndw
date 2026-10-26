package ringtest

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"mndwd/internal/telemetry/ring"
)

type faultKey struct {
	op   string
	path string
}

// MemFS is a fault-injecting filesystem with explicit file and directory durability.
type MemFS struct {
	mu           sync.Mutex
	files        map[string][]byte
	durableData  map[string][]byte
	durableNames map[string]bool
	dirs         map[string]bool
	durableDirs  map[string]bool
	nextFaults   map[faultKey][]error
	stickyFaults map[faultKey]error
	hook         func(op, path string)
	operations   [][2]string
	openFiles    map[*memFile]struct{}
}

// NewMemFS returns an empty memory filesystem with a durable root directory.
func NewMemFS() *MemFS {
	return &MemFS{
		files:        make(map[string][]byte),
		durableData:  make(map[string][]byte),
		durableNames: make(map[string]bool),
		dirs:         map[string]bool{".": true},
		durableDirs:  map[string]bool{".": true},
		nextFaults:   make(map[faultKey][]error),
		stickyFaults: make(map[faultKey]error),
		openFiles:    make(map[*memFile]struct{}),
	}
}

// FailNext makes the next matching operation fail once.
func (m *MemFS) FailNext(op, path string, err error) {
	m.mu.Lock()

	defer m.mu.Unlock()

	key := faultKey{op: op, path: clean(path)}

	if err == nil {
		err = errors.New("ringtest: injected failure")
	}

	m.nextFaults[key] = append(m.nextFaults[key], err)
}

// FailAlways makes every matching operation fail until Heal is called.
func (m *MemFS) FailAlways(op, path string, err error) {
	m.mu.Lock()

	defer m.mu.Unlock()

	if err == nil {
		err = errors.New("ringtest: injected failure")
	}

	m.stickyFaults[faultKey{op: op, path: clean(path)}] = err
}

// Heal removes all injected failures.
func (m *MemFS) Heal() {
	m.mu.Lock()

	defer m.mu.Unlock()

	m.nextFaults = make(map[faultKey][]error)
	m.stickyFaults = make(map[faultKey]error)
}

// OnOp registers a callback invoked for each attempted operation.
func (m *MemFS) OnOp(callback func(op, path string)) {
	m.mu.Lock()

	defer m.mu.Unlock()

	m.hook = callback
}

// Operations returns the recorded operations in call order.
func (m *MemFS) Operations() [][2]string {
	m.mu.Lock()

	defer m.mu.Unlock()

	return append([][2]string(nil), m.operations...)
}

// Bytes returns a copy of a file's current contents.
func (m *MemFS) Bytes(path string) []byte {
	m.mu.Lock()

	defer m.mu.Unlock()

	return append([]byte(nil), m.files[clean(path)]...)
}

// Exists reports whether a file or directory currently exists.
func (m *MemFS) Exists(path string) bool {
	m.mu.Lock()

	defer m.mu.Unlock()

	path = clean(path)
	_, fileExists := m.files[path]

	return fileExists || m.dirs[path]
}

// Crash restores synchronized file data and directory entries and closes handles.
func (m *MemFS) Crash() {
	m.mu.Lock()

	defer m.mu.Unlock()

	files := make(map[string][]byte)

	for path, exists := range m.durableNames {
		if exists {
			files[path] = append([]byte(nil), m.durableData[path]...)
		}
	}

	dirs := make(map[string]bool)

	for path, exists := range m.durableDirs {
		if exists {
			dirs[path] = true
		}
	}

	dirs["."] = true
	m.files = files
	m.dirs = dirs

	for file := range m.openFiles {
		file.closed = true
	}

	m.openFiles = make(map[*memFile]struct{})
}

// OpenFile opens a file in memory using os.OpenFile flag semantics.
func (m *MemFS) OpenFile(name string, flag int, _ fs.FileMode) (ring.File, error) {
	path := clean(name)

	m.mu.Lock()

	defer m.mu.Unlock()

	if err := m.recordLocked("open", path); err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}

	data, exists := m.files[path]

	if !exists {
		if flag&os.O_CREATE == 0 {
			return nil, &os.PathError{Op: "open", Path: path, Err: fs.ErrNotExist}
		}

		if !m.dirs[filepath.Dir(path)] {
			return nil, &os.PathError{Op: "open", Path: path, Err: fs.ErrNotExist}
		}

		m.files[path] = nil
		data = nil
	} else if flag&os.O_CREATE != 0 && flag&os.O_EXCL != 0 {
		return nil, &os.PathError{Op: "open", Path: path, Err: fs.ErrExist}
	}

	if flag&os.O_TRUNC != 0 {
		m.files[path] = nil
		data = nil
	}

	file := &memFile{fsys: m, path: path, flags: flag}
	m.openFiles[file] = struct{}{}
	_ = data

	return file, nil
}

// Remove removes a file or empty directory from the current namespace.
func (m *MemFS) Remove(name string) error {
	path := clean(name)

	m.mu.Lock()

	defer m.mu.Unlock()

	if err := m.recordLocked("remove", path); err != nil {
		return &os.PathError{Op: "remove", Path: path, Err: err}
	}

	if _, exists := m.files[path]; exists {
		delete(m.files, path)

		return nil
	}

	if m.dirs[path] && !m.hasChildrenLocked(path) {
		delete(m.dirs, path)

		return nil
	}

	return &os.PathError{Op: "remove", Path: path, Err: fs.ErrNotExist}
}

// Rename renames a file in the current namespace.
func (m *MemFS) Rename(oldName, newName string) error {
	oldPath := clean(oldName)
	newPath := clean(newName)

	m.mu.Lock()

	defer m.mu.Unlock()

	if err := m.recordLocked("rename", oldPath); err != nil {
		return &os.PathError{Op: "rename", Path: oldPath, Err: err}
	}

	data, exists := m.files[oldPath]

	if !exists {
		return &os.PathError{Op: "rename", Path: oldPath, Err: fs.ErrNotExist}
	}

	if !m.dirs[filepath.Dir(newPath)] {
		return &os.PathError{Op: "rename", Path: newPath, Err: fs.ErrNotExist}
	}

	m.files[newPath] = append([]byte(nil), data...)

	if durable, ok := m.durableData[oldPath]; ok {
		m.durableData[newPath] = append([]byte(nil), durable...)
	}

	delete(m.files, oldPath)

	return nil
}

// MkdirAll creates a directory and its parents in the current namespace.
func (m *MemFS) MkdirAll(name string, _ fs.FileMode) error {
	path := clean(name)

	m.mu.Lock()

	defer m.mu.Unlock()

	if err := m.recordLocked("mkdirall", path); err != nil {
		return &os.PathError{Op: "mkdir", Path: path, Err: err}
	}

	if path == "." {
		return nil
	}

	var missing []string

	for current := path; current != "." && current != string(filepath.Separator); current = filepath.Dir(current) {
		if m.dirs[current] {
			break
		}

		if _, exists := m.files[current]; exists {
			return &os.PathError{Op: "mkdir", Path: current, Err: syscall.ENOTDIR}
		}

		missing = append(missing, current)
	}

	for index := len(missing) - 1; index >= 0; index-- {
		m.dirs[missing[index]] = true
	}

	return nil
}

// ReadDir lists direct children of a directory.
func (m *MemFS) ReadDir(name string) ([]fs.DirEntry, error) {
	path := clean(name)

	m.mu.Lock()

	defer m.mu.Unlock()

	if err := m.recordLocked("readdir", path); err != nil {
		return nil, &os.PathError{Op: "readdir", Path: path, Err: err}
	}

	if !m.dirs[path] {
		return nil, &os.PathError{Op: "readdir", Path: path, Err: fs.ErrNotExist}
	}

	names := make(map[string]bool)

	for filePath := range m.files {
		if filepath.Dir(filePath) == path {
			names[filepath.Base(filePath)] = false
		}
	}

	for dirPath := range m.dirs {
		if dirPath != path && filepath.Dir(dirPath) == path {
			names[filepath.Base(dirPath)] = true
		}
	}

	entries := make([]fs.DirEntry, 0, len(names))

	for name, isDir := range names {
		entries = append(entries, memDirEntry{name: name, isDir: isDir})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	return entries, nil
}

// SyncDir makes the current direct child names durable.
func (m *MemFS) SyncDir(name string) error {
	path := clean(name)

	m.mu.Lock()

	defer m.mu.Unlock()

	if err := m.recordLocked("syncdir", path); err != nil {
		return &os.PathError{Op: "syncdir", Path: path, Err: err}
	}

	if !m.dirs[path] {
		return &os.PathError{Op: "syncdir", Path: path, Err: fs.ErrNotExist}
	}

	for child := range m.durableNames {
		if filepath.Dir(child) == path {
			if _, exists := m.files[child]; !exists {
				delete(m.durableNames, child)
				delete(m.durableData, child)
			}
		}
	}

	for child := range m.files {
		if filepath.Dir(child) == path {
			m.durableNames[child] = true
		}
	}

	for child := range m.durableDirs {
		if filepath.Dir(child) == path && !m.dirs[child] {
			delete(m.durableDirs, child)
		}
	}

	for child := range m.dirs {
		if child != path && filepath.Dir(child) == path {
			m.durableDirs[child] = true
		}
	}

	return nil
}

func (m *MemFS) recordLocked(op, path string) error {
	m.operations = append(m.operations, [2]string{op, path})

	if m.hook != nil {
		m.hook(op, path)
	}

	key := faultKey{op: op, path: path}

	if err := m.stickyFaults[key]; err != nil {
		return err
	}

	if faults := m.nextFaults[key]; len(faults) > 0 {
		m.nextFaults[key] = faults[1:]

		if len(m.nextFaults[key]) == 0 {
			delete(m.nextFaults, key)
		}

		return faults[0]
	}

	return nil
}

func (m *MemFS) hasChildrenLocked(path string) bool {
	for filePath := range m.files {
		if filepath.Dir(filePath) == path {
			return true
		}
	}

	for dirPath := range m.dirs {
		if dirPath != path && filepath.Dir(dirPath) == path {
			return true
		}
	}

	return false
}

type memFile struct {
	fsys   *MemFS
	path   string
	flags  int
	closed bool
}

func (f *memFile) ReadAt(data []byte, offset int64) (int, error) {
	m := f.fsys

	m.mu.Lock()

	defer m.mu.Unlock()

	if f.closed {
		return 0, os.ErrClosed
	}

	if f.flags&(os.O_WRONLY|os.O_RDWR) == os.O_WRONLY {
		return 0, fs.ErrPermission
	}

	if err := m.recordLocked("readat", f.path); err != nil {
		return 0, err
	}

	if offset < 0 {
		return 0, errors.New("negative offset")
	}

	dataBytes, exists := m.files[f.path]

	if !exists {
		return 0, fs.ErrNotExist
	}

	if len(data) == 0 {
		return 0, nil
	}

	if offset >= int64(len(dataBytes)) {
		return 0, io.EOF
	}

	n := copy(data, dataBytes[int(offset):])

	if n != len(data) {
		return n, io.EOF
	}

	return n, nil
}

func (f *memFile) WriteAt(data []byte, offset int64) (int, error) {
	m := f.fsys

	m.mu.Lock()

	defer m.mu.Unlock()

	if f.closed {
		return 0, os.ErrClosed
	}

	if f.flags&os.O_WRONLY == 0 && f.flags&os.O_RDWR == 0 {
		return 0, fs.ErrPermission
	}

	if err := m.recordLocked("writeat", f.path); err != nil {
		return 0, err
	}

	if offset < 0 {
		return 0, errors.New("negative offset")
	}

	if offset > int64(int(^uint(0)>>1)) || int64(len(data)) > int64(int(^uint(0)>>1))-offset {
		return 0, errors.New("file too large")
	}

	contents := m.files[f.path]
	end := int(offset) + len(data)

	if end > len(contents) {
		grown := make([]byte, end)

		copy(grown, contents)

		contents = grown
	}

	copy(contents[int(offset):], data)

	m.files[f.path] = contents

	return len(data), nil
}

func (f *memFile) Truncate(size int64) error {
	m := f.fsys

	m.mu.Lock()

	defer m.mu.Unlock()

	if f.closed {
		return os.ErrClosed
	}

	if f.flags&os.O_WRONLY == 0 && f.flags&os.O_RDWR == 0 {
		return fs.ErrPermission
	}

	if err := m.recordLocked("truncate", f.path); err != nil {
		return err
	}

	if size < 0 || size > int64(int(^uint(0)>>1)) {
		return errors.New("invalid truncate size")
	}

	contents := m.files[f.path]

	if int(size) <= len(contents) {
		m.files[f.path] = append([]byte(nil), contents[:int(size)]...)

		return nil
	}

	grown := make([]byte, int(size))

	copy(grown, contents)

	m.files[f.path] = grown

	return nil
}

func (f *memFile) Sync() error {
	m := f.fsys

	m.mu.Lock()

	defer m.mu.Unlock()

	if f.closed {
		return os.ErrClosed
	}

	if err := m.recordLocked("sync", f.path); err != nil {
		return err
	}

	contents, exists := m.files[f.path]

	if !exists {
		return fs.ErrNotExist
	}

	m.durableData[f.path] = append([]byte(nil), contents...)

	return nil
}

func (f *memFile) Close() error {
	m := f.fsys

	m.mu.Lock()

	defer m.mu.Unlock()

	if f.closed {
		return nil
	}

	err := m.recordLocked("close", f.path)
	f.closed = true

	delete(m.openFiles, f)

	return err
}

type memDirEntry struct {
	name  string
	isDir bool
}

func (e memDirEntry) Name() string { return e.name }
func (e memDirEntry) IsDir() bool  { return e.isDir }
func (e memDirEntry) Type() fs.FileMode {
	if e.isDir {
		return fs.ModeDir
	}

	return 0
}
func (e memDirEntry) Info() (fs.FileInfo, error) {
	return memFileInfo{name: e.name, isDir: e.isDir}, nil
}

type memFileInfo struct {
	name  string
	isDir bool
}

func (i memFileInfo) Name() string { return i.name }
func (i memFileInfo) Size() int64  { return 0 }
func (i memFileInfo) Mode() fs.FileMode {
	if i.isDir {
		return fs.ModeDir | 0o755
	}

	return 0o600
}
func (i memFileInfo) ModTime() time.Time { return time.Time{} }
func (i memFileInfo) IsDir() bool        { return i.isDir }
func (i memFileInfo) Sys() any           { return nil }

func clean(path string) string {
	if strings.TrimSpace(path) == "" {
		return "."
	}

	return filepath.Clean(path)
}

var _ ring.FS = (*MemFS)(nil)
var _ ring.File = (*memFile)(nil)
