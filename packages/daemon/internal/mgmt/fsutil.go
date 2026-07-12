package mgmt

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// maxUncompressedBytes caps the total extracted size of an upload, guarding against
// zip bombs even after the 10 MB compressed cap is honored.
const maxUncompressedBytes = 64 << 20 // 64 MiB

// maxZipEntries caps the number of files in an upload.
const maxZipEntries = 2000

// manifestFileName is the fixed name of the manifest at the zip root.
const manifestFileName = "manifest.json"

// readManifestFromZip locates and reads manifest.json at the archive root without
// extracting anything (validation happens before we touch the filesystem).
func readManifestFromZip(zr *zip.Reader) ([]byte, error) {
	for _, f := range zr.File {
		if f.Name == manifestFileName {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()

			return io.ReadAll(io.LimitReader(rc, maxUncompressedBytes))
		}
	}

	return nil, errNoManifest
}

var errNoManifest = errors.New("manifest.json not found at archive root")

// extractZip writes the archive into dest with zip-slip protection: every entry is
// re-rooted under dest and rejected if it would escape. dest is created fresh.
func extractZip(zr *zip.Reader, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}

	if len(zr.File) > maxZipEntries {
		return fmt.Errorf("archive has too many entries (%d > %d)", len(zr.File), maxZipEntries)
	}

	var written int64
	for _, f := range zr.File {
		target, err := safeJoin(dest, f.Name)
		if err != nil {
			return err
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}

			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}

		written, err = copyZipFile(f, target, written)
		if err != nil {
			return err
		}
	}

	return nil
}

func copyZipFile(f *zip.File, target string, written int64) (int64, error) {
	rc, err := f.Open()
	if err != nil {
		return written, err
	}
	defer rc.Close()

	// Uploaded plugins are static/script assets; store without the write/exec bits.
	// Approval re-applies +x to declared scripts only.
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return written, err
	}
	defer out.Close()

	remaining := maxUncompressedBytes - written
	n, err := io.Copy(out, io.LimitReader(rc, remaining+1))
	written += n
	if err != nil {
		return written, err
	}
	if written > maxUncompressedBytes {
		return written, fmt.Errorf("archive exceeds uncompressed size limit (%d bytes)", maxUncompressedBytes)
	}

	return written, nil
}

// safeJoin joins name onto base, rejecting (not silently clamping) any entry that
// would escape base — the zip-slip guard. Also rejects backslashes (Windows-style
// separators a plugin has no business shipping).
func safeJoin(base, name string) (string, error) {
	if strings.Contains(name, `\`) {
		return "", fmt.Errorf("illegal path in archive: %q", name)
	}

	joined := filepath.Join(base, name) // Join cleans, resolving any traversal
	if joined != base && !strings.HasPrefix(joined, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("illegal path in archive escapes plugin dir: %q", name)
	}

	return joined, nil
}

// moveDir moves src to dst, falling back to copy+remove when a plain rename fails
// (e.g. staging and user dirs on different filesystems in a dev layout).
func moveDir(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	_ = os.RemoveAll(dst)

	if err := os.Rename(src, dst); err == nil {
		return nil
	}

	if err := copyTree(src, dst); err != nil {
		return err
	}

	return os.RemoveAll(src)
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)

		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}

		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()

		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		defer out.Close()

		_, err = io.Copy(out, in)

		return err
	})
}

// chmodExecutable sets the executable bits on a file that must be run as a script.
func chmodExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}

	return os.Chmod(path, info.Mode().Perm()|0o111)
}
