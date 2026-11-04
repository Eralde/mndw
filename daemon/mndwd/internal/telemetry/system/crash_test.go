package system

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

func TestCrashAtEveryAcceptanceStep(t *testing.T) {
	if testing.Short() {
		t.Skip("crash sweep runs in the weekly CI job")
	}

	baselineFS := crashFixture(t)
	baselineSource := &fakeNTP{bodies: [][]byte{invalidNTPBody(), validNTPBody()}}
	baselineEngine, baselineClock, _ := startEngine(t, baselineFS, testBootA, 0, baselineSource, func(context.Context) []float32 {
		return []float32{8, 9, 10}
	})
	startOps := len(baselineFS.Operations())

	baselineClock.set(testReading(370_000))

	if err := baselineEngine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("baseline Handle(EventTick) error = %v", err)
	}

	baselineOps := baselineFS.Operations()[startOps:]

	if len(baselineOps) == 0 {
		t.Fatal("acceptance produced no filesystem operations")
	}

	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()
	baselineRing := readRing(t, baselineFS, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory))

	requireValues(t, baselineRing, offset/180_000, []float32{1, 2, 3})
	requireValues(t, baselineRing, offset/180_000+1, []float32{8, 9, 10})

	_ = baselineEngine.Stop(context.Background())

	for crashAt := range baselineOps {
		t.Run(fmt.Sprintf("operation-%02d-%s-%s", crashAt, baselineOps[crashAt][0], filepath.Base(baselineOps[crashAt][1])), func(t *testing.T) {
			fsys := crashFixture(t)
			source := &fakeNTP{bodies: [][]byte{invalidNTPBody(), validNTPBody()}}
			engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, func(context.Context) []float32 {
				return []float32{8, 9, 10}
			})
			opCount := 0

			fsys.OnOp(func(string, string) {
				if opCount == crashAt {
					panic("simulated power loss")
				}

				opCount++
			})
			clock.set(testReading(370_000))
			func() {
				defer func() {
					if recover() == nil {
						t.Fatalf("operation %d did not trigger simulated power loss", crashAt)
					}
				}()

				_ = engine.Handle(context.Background(), EventTick)
			}()
			fsys.OnOp(nil)
			fsys.Crash()

			recoveredSource := &fakeNTP{bodies: [][]byte{validNTPBody()}}
			recovered, _, _ := startEngine(t, fsys, testBootA, 370_000, recoveredSource, nil)

			defer func() { _ = recovered.Stop(context.Background()) }()

			ensureAbsent(t, fsys, pendingPath(testBootA))

			recoveredRing := readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory))

			requireValues(t, recoveredRing, offset/180_000, []float32{1, 2, 3})

			stateBytes := fsys.Bytes(filepath.Join(testDir, "clock.state"))

			if len(stateBytes) != 0 {
				if _, err := timekeeper.DecodeState(stateBytes); err != nil {
					t.Fatalf("clock.state is torn after recovery: %v", err)
				}
			}
		})
	}
}

func crashFixture(t *testing.T) *ringtest.MemFS {
	t.Helper()

	fsys := ringtest.NewMemFS()

	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)
	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{0: {1, 2, 3}})

	return fsys
}
