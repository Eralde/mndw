package backend

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type ValidatedCommand struct {
	Path string
}

func ValidateCommand(pluginDir, relative string) (ValidatedCommand, error) {
	return validateCommand(pluginDir, relative, false)
}

// validateBuiltinCommand permits the trusted dev-only builtin root symlink used by `mndw dev`.
// It keeps command-path symlink rejection unchanged.
func validateBuiltinCommand(pluginDir, relative string) (ValidatedCommand, error) {
	return validateCommand(pluginDir, relative, true)
}

func validateCommand(pluginDir, relative string, allowRootSymlink bool) (ValidatedCommand, error) {
	if relative == "" || filepath.IsAbs(relative) || strings.ContainsAny(relative, `\\`) || strings.Contains(relative, "..") {
		return ValidatedCommand{}, fmt.Errorf("command path is not safe: %q", relative)
	}

	for _, segment := range strings.Split(relative, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return ValidatedCommand{}, fmt.Errorf("command path contains unsafe segment: %q", relative)
		}
	}

	root := filepath.Clean(pluginDir)
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return ValidatedCommand{}, fmt.Errorf("inspect plugin directory: %w", err)
	}

	if rootInfo.Mode()&os.ModeSymlink != 0 {
		if !allowRootSymlink {
			return ValidatedCommand{}, fmt.Errorf("plugin directory is not a real directory: %q", pluginDir)
		}

		rootInfo, err = os.Stat(root)
		if err != nil {
			return ValidatedCommand{}, fmt.Errorf("inspect plugin directory: %w", err)
		}
	}

	if !rootInfo.IsDir() {
		return ValidatedCommand{}, fmt.Errorf("plugin directory is not a real directory: %q", pluginDir)
	}

	path := filepath.Join(root, filepath.FromSlash(relative))

	if path != root && !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return ValidatedCommand{}, fmt.Errorf("command escapes plugin directory: %q", relative)
	}

	relPath, err := filepath.Rel(root, path)
	if err != nil {
		return ValidatedCommand{}, fmt.Errorf("resolve command path: %w", err)
	}

	current := root

	for _, segment := range strings.Split(relPath, string(filepath.Separator)) {
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if err != nil {
			return ValidatedCommand{}, fmt.Errorf("inspect command path: %w", err)
		}

		if info.Mode()&os.ModeSymlink != 0 {
			return ValidatedCommand{}, fmt.Errorf("command path contains symlink: %q", relative)
		}
	}

	info, err := os.Stat(path)
	if err != nil {
		return ValidatedCommand{}, fmt.Errorf("inspect command: %w", err)
	}

	if !info.Mode().IsRegular() {
		return ValidatedCommand{}, fmt.Errorf("command is not a regular file: %q", relative)
	}

	if info.Mode().Perm()&0o111 == 0 {
		return ValidatedCommand{}, fmt.Errorf("command is not executable: %q", relative)
	}

	file, err := os.Open(path)
	if err != nil {
		return ValidatedCommand{}, fmt.Errorf("open command: %w", err)
	}

	defer file.Close()

	if err := validateShebang(file, relative); err != nil {
		return ValidatedCommand{}, err
	}

	return ValidatedCommand{Path: path}, nil
}

const maxShebangBytes = 4096

func validateShebang(file *os.File, relative string) error {
	prefix := make([]byte, 2)
	read, err := io.ReadFull(file, prefix)
	if err != nil {
		if read < len(prefix) && (err == io.EOF || err == io.ErrUnexpectedEOF) {
			return nil
		}

		return fmt.Errorf("read command: %w", err)
	}

	if !bytes.Equal(prefix, []byte("#!")) {
		return nil
	}

	shebang := make([]byte, maxShebangBytes)

	copy(shebang, prefix)

	read, err = io.ReadFull(file, shebang[len(prefix):])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return fmt.Errorf("read command: %w", err)
	}

	shebang = shebang[:len(prefix)+read]
	lineEnd := bytes.IndexByte(shebang, '\n')

	if lineEnd < 0 && len(shebang) == maxShebangBytes {
		return fmt.Errorf("read command: shebang line too long")
	}

	line := string(shebang)

	if lineEnd >= 0 {
		line = line[:lineEnd]
	}

	fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(line, "#!")))

	if len(fields) == 0 {
		return fmt.Errorf("command has empty shebang: %q", relative)
	}

	interpreter := fields[0]

	if interpreter == "/usr/bin/env" || interpreter == "/bin/env" {
		if len(fields) != 2 || strings.ContainsAny(fields[1], `/\\`) {
			return fmt.Errorf("command has invalid env shebang: %q", relative)
		}

		interpreter = fields[1]
	}

	if !filepath.IsAbs(interpreter) && strings.Contains(interpreter, "/") {
		return fmt.Errorf("command has invalid interpreter path: %q", relative)
	}

	if _, err := exec.LookPath(interpreter); err != nil {
		return fmt.Errorf("command interpreter unavailable: %w", err)
	}

	return nil
}
