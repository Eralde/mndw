package system

import (
	"context"
	"path/filepath"
	"testing"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

func TestTransferUsesFloorOffsetMapping(t *testing.T) {
	fsys := ringtest.NewMemFS()
	step := int64(ring.SystemSchema(ring.KindHistory).StepMs)
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli() + 2*step + step - 1

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"})
	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{17: {2, 4, 6}})

	engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	wantSlot := int64(17) + offset/step

	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), wantSlot, []float32{2, 4, 6})
}
