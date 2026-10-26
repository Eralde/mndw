package ring

import (
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// File is the random-access storage used by a ring.
type File interface {
	io.ReaderAt
	io.WriterAt
	Truncate(int64) error
	Sync() error
	Close() error
}

// FS contains the filesystem operations used by ring storage.
type FS interface {
	OpenFile(name string, flag int, perm fs.FileMode) (File, error)
	Remove(name string) error
	Rename(oldName, newName string) error
	MkdirAll(name string, perm fs.FileMode) error
	ReadDir(name string) ([]fs.DirEntry, error)
	SyncDir(name string) error
}

// OSFS delegates ring filesystem operations to the operating system.
type OSFS struct{}

type osFile struct {
	file *os.File
}

func (f *osFile) ReadAt(data []byte, offset int64) (int, error) {
	return f.file.ReadAt(data, offset)
}

func (f *osFile) WriteAt(data []byte, offset int64) (int, error) {
	return f.file.WriteAt(data, offset)
}

func (f *osFile) Truncate(size int64) error {
	return f.file.Truncate(size)
}

func (f *osFile) Sync() error {
	return f.file.Sync()
}

func (f *osFile) Close() error {
	return f.file.Close()
}

// OpenFile opens a file through the operating system.
func (OSFS) OpenFile(name string, flag int, perm fs.FileMode) (File, error) {
	file, err := os.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}

	return &osFile{file: file}, nil
}

// Remove removes a file through the operating system.
func (OSFS) Remove(name string) error {
	return os.Remove(name)
}

// Rename renames a file through the operating system.
func (OSFS) Rename(oldName, newName string) error {
	return os.Rename(oldName, newName)
}

// MkdirAll creates a directory path through the operating system.
func (OSFS) MkdirAll(name string, perm fs.FileMode) error {
	return os.MkdirAll(name, perm)
}

// ReadDir lists a directory through the operating system.
func (OSFS) ReadDir(name string) ([]fs.DirEntry, error) {
	return os.ReadDir(name)
}

// SyncDir synchronizes directory entries through the operating system.
func (OSFS) SyncDir(name string) error {
	dir, err := os.Open(name)
	if err != nil {
		return err
	}

	if err := dir.Sync(); err != nil {
		_ = dir.Close()

		return err
	}

	return dir.Close()
}

func parentDir(path string) string {
	parent := filepath.Dir(path)

	if parent == "" {
		return "."
	}

	return parent
}
