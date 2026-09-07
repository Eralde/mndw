package journal

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// File is the subset of file behavior the journal uses. It exists so tests can
// inject a crash-modeling filesystem instead of the real one.
type File interface {
	io.Reader
	io.Writer
	io.Seeker
	Sync() error
	Truncate(int64) error
	Close() error
}

// FileSystem is every filesystem operation the journal performs. Every
// durability barrier goes through it, including directory synchronization.
type FileSystem interface {
	OpenFile(string, int, os.FileMode) (File, error)
	ReadFile(string) ([]byte, error)
	ReadDir(string) ([]os.DirEntry, error)
	Rename(string, string) error
	Remove(string) error
	MkdirAll(string, os.FileMode) error
	MkdirTemp(string, string) (string, error)
	Stat(string) (os.FileInfo, error)
	SyncDir(string) error
}

// OSFileSystem delegates to the operating system.
type OSFileSystem struct{}

type osFile struct {
	file *os.File
}

func (f *osFile) Read(p []byte) (int, error)  { return f.file.Read(p) }
func (f *osFile) Write(p []byte) (int, error) { return f.file.Write(p) }
func (f *osFile) Seek(offset int64, whence int) (int64, error) {
	return f.file.Seek(offset, whence)
}
func (f *osFile) Sync() error               { return f.file.Sync() }
func (f *osFile) Truncate(size int64) error { return f.file.Truncate(size) }
func (f *osFile) Close() error              { return f.file.Close() }

// OpenFile opens a file through the operating system.
func (OSFileSystem) OpenFile(name string, flag int, perm os.FileMode) (File, error) {
	file, err := os.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	return &osFile{file: file}, nil
}

// ReadFile reads a whole file through the operating system.
func (OSFileSystem) ReadFile(name string) ([]byte, error) { return os.ReadFile(name) }

// ReadDir lists a directory through the operating system.
func (OSFileSystem) ReadDir(name string) ([]os.DirEntry, error) { return os.ReadDir(name) }

// Rename renames through the operating system.
func (OSFileSystem) Rename(oldPath, newPath string) error { return os.Rename(oldPath, newPath) }

// Remove removes through the operating system.
func (OSFileSystem) Remove(name string) error { return os.Remove(name) }

// MkdirAll creates directories through the operating system.
func (OSFileSystem) MkdirAll(name string, perm os.FileMode) error { return os.MkdirAll(name, perm) }

// MkdirTemp creates a temporary directory through the operating system.
func (OSFileSystem) MkdirTemp(dir, pattern string) (string, error) {
	return os.MkdirTemp(dir, pattern)
}

// Stat stats through the operating system.
func (OSFileSystem) Stat(name string) (os.FileInfo, error) { return os.Stat(name) }

// SyncDir synchronizes a directory entry through the operating system.
func (OSFileSystem) SyncDir(name string) error {
	file, err := os.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	if err := file.Sync(); err != nil {
		return err
	}
	return file.Close()
}

// StoragePaths is the only accepted form of journal location. JournalDir is
// always the `staging` child of the RRD directory; callers cannot configure it
// independently.
type StoragePaths struct {
	RRDDir     string
	JournalDir string
}

// journalDirName is the fixed child of RRDDir that holds journal state.
const journalDirName = "staging"

// PathsFromRRDDir is the only constructor of StoragePaths. It rejects an empty
// or filesystem-root parent so no caller can pass an unqualified root across
// this boundary.
func PathsFromRRDDir(rrdDir string) (StoragePaths, error) {
	if strings.TrimSpace(rrdDir) == "" {
		return StoragePaths{}, ErrInvalidPaths
	}
	cleaned, err := filepath.Abs(filepath.Clean(rrdDir))
	if err != nil {
		return StoragePaths{}, err
	}
	if cleaned == string(filepath.Separator) || filepath.Dir(cleaned) == cleaned {
		return StoragePaths{}, ErrInvalidPaths
	}
	return StoragePaths{RRDDir: cleaned, JournalDir: filepath.Join(cleaned, journalDirName)}, nil
}

// segmentFilePrefix identifies journal segment files inside JournalDir.
const segmentFilePrefix = "seg-"

// segmentFileExtension is the extension of every segment file.
const segmentFileExtension = ".jnl"

// segmentNames lists the segment files in a directory, oldest identity first.
func segmentNames(entries []os.DirEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, segmentFilePrefix) && strings.HasSuffix(name, segmentFileExtension) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}
