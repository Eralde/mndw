package system

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/timekeeper"
)

const maxClockStateSize = 8 + 2 + 16 + 8 + 8 + 2 + 255 + 4

func readClockState(fsys ring.FS, path string) (*timekeeper.State, error) {
	file, err := fsys.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}

		return nil, fmt.Errorf("%w: open clock.state: %w", ring.ErrIO, err)
	}

	defer func() {
		_ = file.Close()
	}()

	body := make([]byte, maxClockStateSize+1)
	n, err := file.ReadAt(body, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: read clock.state: %w", ring.ErrIO, err)
	}

	if n > maxClockStateSize {
		return nil, nil
	}

	state, err := timekeeper.DecodeState(body[:n])
	if err != nil {
		return nil, nil
	}

	return &state, nil
}

func writeClockState(fsys ring.FS, dir string, state timekeeper.State) error {
	body, err := timekeeper.EncodeState(state)
	if err != nil {
		return err
	}

	tmpPath := dir + string(os.PathSeparator) + "clock.state.tmp"
	statePath := dir + string(os.PathSeparator) + "clock.state"
	file, err := fsys.OpenFile(tmpPath, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("%w: open clock.state.tmp: %w", ring.ErrIO, err)
	}

	written, writeErr := file.WriteAt(body, 0)

	if writeErr == nil && written != len(body) {
		writeErr = io.ErrShortWrite
	}

	if writeErr != nil {
		_ = file.Close()

		return fmt.Errorf("%w: write clock.state.tmp: %w", ring.ErrIO, writeErr)
	}

	if err := file.Sync(); err != nil {
		_ = file.Close()

		return fmt.Errorf("%w: sync clock.state.tmp: %w", ring.ErrIO, err)
	}

	if err := file.Close(); err != nil {
		return fmt.Errorf("%w: close clock.state.tmp: %w", ring.ErrIO, err)
	}

	if err := fsys.Rename(tmpPath, statePath); err != nil {
		return fmt.Errorf("%w: rename clock.state.tmp: %w", ring.ErrIO, err)
	}

	if err := fsys.SyncDir(dir); err != nil {
		return fmt.Errorf("%w: sync clock.state directory: %w", ring.ErrIO, err)
	}

	return nil
}
