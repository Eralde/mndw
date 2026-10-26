package system

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"

	"mndwd/internal/telemetry/ring"
)

func (e *Engine) transferPending(path string, offsetMs int64, recreateInvalid bool) error {
	if filepath.Clean(path) == filepath.Clean(e.currentPendingPath()) && e.currentPending != nil {
		if err := e.currentPending.Close(); err != nil {
			return err
		}

		e.currentPending = nil
	}

	pending, err := ring.Open(e.cfg.FS, path, ring.SystemSchema(ring.KindPending), false)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}

		if errors.Is(err, ring.ErrInvalidHeader) {
			if recreateInvalid {
				pending, err = ring.Open(e.cfg.FS, path, ring.SystemSchema(ring.KindPending), true)
				if err != nil {
					return err
				}

				if err := pending.Close(); err != nil {
					return err
				}

				return nil
			}

			return e.removePending(path)
		}

		return err
	}

	defer func() {
		_ = pending.Close()
	}()

	if !pending.HasRows() {
		if err := pending.Close(); err != nil {
			return err
		}

		return e.removePending(path)
	}

	e.replayPending = true
	step := int64(ring.SystemSchema(ring.KindHistory).StepMs)
	shift := offsetMs / step
	var transferErr error

	pending.EachRow(func(bootSlot int64, values []float32) {
		if transferErr != nil {
			return
		}

		if err := e.history.Write(bootSlot+shift, values); err != nil {
			transferErr = err
		}
	})

	if transferErr != nil {
		return transferErr
	}

	if err := e.history.Sync(); err != nil {
		return err
	}

	e.historyDirty = false

	if err := pending.Close(); err != nil {
		return err
	}

	if err := e.removePending(path); err != nil {
		return err
	}

	e.replayPending = false
	e.currentPending = nil

	if filepath.Clean(path) == filepath.Clean(e.currentPendingPath()) {
		e.currentPendingPathKnown = false
	}

	return nil
}

func (e *Engine) removePending(path string) error {
	if err := e.cfg.FS.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: remove pending file: %w", ring.ErrIO, err)
	}

	if err := e.cfg.FS.SyncDir(filepath.Join(e.cfg.Dir, "pending")); err != nil {
		return fmt.Errorf("%w: sync pending directory: %w", ring.ErrIO, err)
	}

	return nil
}
