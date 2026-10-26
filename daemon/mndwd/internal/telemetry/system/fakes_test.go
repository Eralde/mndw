package system

import (
	"context"
	"encoding/hex"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

const testDir = "data/ring"

var (
	testBootA = [16]byte{1}
	testBootB = [16]byte{2}
	testBootC = [16]byte{3}
)

type fakeClock struct {
	mu      sync.Mutex
	bootID  [16]byte
	reading timekeeper.Reading
	reads   int
}

func (c *fakeClock) Read() (timekeeper.Reading, error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.reads++

	return c.reading, nil
}

func (c *fakeClock) BootID() [16]byte {
	return c.bootID
}

func (c *fakeClock) set(reading timekeeper.Reading) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.reading = reading
}

type fakeNTP struct {
	mu        sync.Mutex
	bodies    [][]byte
	errors    []error
	fallback  []byte
	callCount int
	called    func()
}

func (n *fakeNTP) source(context.Context) ([]byte, error) {
	n.mu.Lock()

	defer n.mu.Unlock()

	n.callCount++

	if n.called != nil {
		n.called()
	}

	index := n.callCount - 1

	if index < len(n.errors) && n.errors[index] != nil {
		return nil, n.errors[index]
	}

	if len(n.bodies) == 0 {
		if n.fallback != nil {
			return append([]byte(nil), n.fallback...), nil
		}

		return []byte(`{"elapsed":0,"server":"","accurate":false}`), nil
	}

	if index >= len(n.bodies) {
		if n.fallback != nil {
			return append([]byte(nil), n.fallback...), nil
		}

		index = len(n.bodies) - 1
	}

	return append([]byte(nil), n.bodies[index]...), nil
}

func (n *fakeNTP) calls() int {
	n.mu.Lock()

	defer n.mu.Unlock()

	return n.callCount
}

type viewRecorder struct {
	views []View
}

func (r *viewRecorder) publish(view View) {
	r.views = append(r.views, view)
}

func (r *viewRecorder) last(t *testing.T) View {
	t.Helper()

	if len(r.views) == 0 {
		t.Fatal("no view was published")
	}

	return r.views[len(r.views)-1]
}

func testConfig(fsys *ringtest.MemFS, clock *fakeClock, source *fakeNTP, publisher *viewRecorder, collector Collector) Config {
	return Config{
		Dir:     testDir,
		FS:      fsys,
		Clock:   clock,
		NTP:     source.source,
		Collect: collector,
		Publish: publisher.publish,
		Keeper:  timekeeper.DefaultConfig(),
		Delay:   10 * time.Second,
	}
}

func testReading(bootMs int64) timekeeper.Reading {
	return timekeeper.Reading{
		BootMs: bootMs,
		WallMs: timekeeper.DefaultConfig().MinValidUTC.UnixMilli() + bootMs,
	}
}

func validNTPBody() []byte {
	return []byte(`{"elapsed":0,"server":"pool.ntp.org","accurate":true,"synchronized":true,"ndsstime":false,"usertime":false}`)
}

func invalidNTPBody() []byte {
	return []byte(`{"elapsed":0,"server":"","accurate":false,"synchronized":false,"ndsstime":false,"usertime":false}`)
}

func bootName(bootID [16]byte) string {
	return hex.EncodeToString(bootID[:])
}

func pendingPath(bootID [16]byte) string {
	return filepath.Join(testDir, "pending", bootName(bootID)+".ring")
}

func seedState(t *testing.T, fsys *ringtest.MemFS, state timekeeper.State) []byte {
	t.Helper()

	if err := fsys.MkdirAll(testDir, 0o755); err != nil {
		t.Fatal(err)
	}

	body, err := timekeeper.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}

	file, err := fsys.OpenFile(filepath.Join(testDir, "clock.state"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Truncate(0); err != nil {
		t.Fatal(err)
	}

	if n, err := file.WriteAt(body, 0); err != nil || n != len(body) {
		t.Fatalf("WriteAt(clock.state) = (%d, %v), want (%d, nil)", n, err, len(body))
	}

	if err := file.Sync(); err != nil {
		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	if err := fsys.SyncDir(testDir); err != nil {
		t.Fatal(err)
	}

	return body
}

func seedRing(t *testing.T, fsys *ringtest.MemFS, path string, schema ring.Schema, rows map[int64][]float32) {
	t.Helper()

	if err := fsys.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	stored, err := ring.Open(fsys, path, schema, true)
	if err != nil {
		t.Fatal(err)
	}

	for slot, values := range rows {
		if err := stored.Write(slot, values); err != nil {
			t.Fatal(err)
		}
	}

	if err := stored.Sync(); err != nil {
		t.Fatal(err)
	}

	if err := stored.Close(); err != nil {
		t.Fatal(err)
	}

	if err := fsys.SyncDir(filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}
}

func readRing(t *testing.T, fsys *ringtest.MemFS, path string, schema ring.Schema) *ring.Ring {
	t.Helper()

	stored, err := ring.Open(fsys, path, schema, false)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		if err := stored.Close(); err != nil && !errorsIsClosed(err) {
			t.Errorf("Close() error = %v", err)
		}
	})

	return stored
}

func errorsIsClosed(err error) bool {
	return err == fs.ErrClosed || err == os.ErrClosed
}

func requireValues(t *testing.T, stored *ring.Ring, slot int64, want []float32) {
	t.Helper()

	got, ok := stored.Values(slot)

	if !ok {
		t.Fatalf("Values(%d) missing, want %v", slot, want)
	}

	if len(got) != len(want) {
		t.Fatalf("Values(%d) length = %d, want %d", slot, len(got), len(want))
	}

	for index := range want {
		if math.IsNaN(float64(want[index])) {
			if !math.IsNaN(float64(got[index])) {
				t.Errorf("Values(%d)[%d] = %v, want NaN", slot, index, got[index])
			}

			continue
		}

		if got[index] != want[index] {
			t.Errorf("Values(%d)[%d] = %v, want %v", slot, index, got[index], want[index])
		}
	}
}

func makeEngine(t *testing.T, fsys *ringtest.MemFS, bootID [16]byte, bootMs int64, source *fakeNTP, collect Collector) (*Engine, *viewRecorder) {
	t.Helper()

	engine, _, views := startEngine(t, fsys, bootID, bootMs, source, collect)

	return engine, views
}

func startEngine(t *testing.T, fsys *ringtest.MemFS, bootID [16]byte, bootMs int64, source *fakeNTP, collect Collector) (*Engine, *fakeClock, *viewRecorder) {
	t.Helper()

	clock := &fakeClock{bootID: bootID, reading: testReading(bootMs)}
	views := &viewRecorder{}
	engine := NewEngine(testConfig(fsys, clock, source, views, collect))

	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	return engine, clock, views
}

func ensureAbsent(t *testing.T, fsys *ringtest.MemFS, path string) {
	t.Helper()

	if fsys.Exists(path) {
		t.Fatalf("%q still exists", path)
	}
}
