package system

import (
	"errors"
	"fmt"
	"path/filepath"

	"mndwd/internal/telemetry/ring"
)

// PublishReadOnly publishes stored history without replaying pending rows or writing storage.
func PublishReadOnly(cfg Config) error {
	if cfg.Clock == nil {
		return errors.New("telemetry system: clock is required for read-only publication")
	}

	if cfg.FS == nil {
		cfg.FS = ring.OSFS{}
	}

	reading, err := cfg.Clock.Read()
	if err != nil {
		return fmt.Errorf("telemetry system: read clock for read-only publication: %w", err)
	}

	history, err := ring.OpenReadOnly(cfg.FS, filepath.Join(cfg.Dir, "system.ring"), ring.SystemSchema(ring.KindHistory))
	if err != nil {
		return err
	}

	state, err := readClockState(cfg.FS, filepath.Join(cfg.Dir, "clock.state"))
	if err != nil {
		return err
	}

	nowMs := reading.WallMs

	if state != nil && state.BootID == cfg.Clock.BootID() {
		nowMs = reading.BootMs + state.OffsetMs
	}

	if cfg.Publish != nil {
		cfg.Publish(View{
			NowMs: nowMs,
			Window: func(startSlot int64, count int) [][]float32 {
				return history.Window(startSlot, count)
			},
		})
	}

	return nil
}
