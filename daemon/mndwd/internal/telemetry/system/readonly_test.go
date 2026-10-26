package system

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

func TestPublishReadOnlyDoesNotWrite(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid ring", true: "corrupt ring header"}[corrupt], func(t *testing.T) {
			fsys := ringtest.NewMemFS()
			stateOffset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

			seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: stateOffset, Server: "pool.ntp.org"})
			seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{1: {1, 2, 3}})

			historyPath := filepath.Join(testDir, "system.ring")

			if corrupt {
				if err := fsys.MkdirAll(testDir, 0o755); err != nil {
					t.Fatal(err)
				}

				file, err := fsys.OpenFile(historyPath, os.O_CREATE|os.O_RDWR, 0o600)
				if err != nil {
					t.Fatal(err)
				}

				badHeader := make([]byte, ring.HeaderSize)

				binary.LittleEndian.PutUint32(badHeader, 17)

				if _, err := file.WriteAt(badHeader, 0); err != nil {
					t.Fatal(err)
				}

				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			}

			clock := &fakeClock{bootID: testBootA, reading: testReading(12_000)}
			var got View
			before := len(fsys.Operations())

			if err := PublishReadOnly(Config{Dir: testDir, FS: fsys, Clock: clock, Publish: func(view View) { got = view }}); err != nil {
				t.Fatalf("PublishReadOnly() error = %v", err)
			}

			if got.NowMs != 12_000+stateOffset || got.Anchored || got.ReplayPending {
				t.Fatalf("view = %+v, want matching offset and unanchored without replay", got)
			}

			if !fsys.Exists(pendingPath(testBootA)) {
				t.Fatal("read-only publication removed previous-boot pending file")
			}

			for _, op := range fsys.Operations()[before:] {
				switch op[0] {
				case "writeat", "truncate", "remove", "rename", "mkdirall":
					t.Fatalf("read-only publication performed mutating operation %v", op)
				}
			}
		})
	}
}
