package telemetry

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
	"mndwd/internal/telemetry/publication"
)

type schemaRecordingFactory struct {
	mu    sync.Mutex
	specs []schemaOpen
}

type schemaOpen struct {
	path string
	spec rrd.CreateSpec
}

func (f *schemaRecordingFactory) Open(path string, spec rrd.CreateSpec, _ rrd.FileOps) (publication.RRDFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	if err := os.WriteFile(path, nil, 0o644); err != nil {
		return nil, err
	}

	f.mu.Lock()

	f.specs = append(f.specs, schemaOpen{path: path, spec: spec})

	f.mu.Unlock()

	return &schemaRecordingFile{}, nil
}

type schemaRecordingFile struct {
	lastUpdate time.Time
}

func (*schemaRecordingFile) Ensure(context.Context, time.Time) error { return nil }

func (f *schemaRecordingFile) Update(_ context.Context, points []rrd.UpdatePoint) error {
	if len(points) > 0 {
		f.lastUpdate = points[len(points)-1].Timestamp
	}

	return nil
}

func (f *schemaRecordingFile) LastUpdate(context.Context) (time.Time, error) {
	return f.lastUpdate, nil
}

func (*schemaRecordingFile) FetchGroup(context.Context, []rrd.FetchRequest) ([]rrd.FetchResult, error) {
	return nil, nil
}

func TestSnapshotAssumptionsMatchPublicationSchemas(t *testing.T) {
	ctx := context.Background()
	paths, err := journal.PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = provider.Close(ctx) })

	if _, err := provider.Reopen(ctx); err != nil {
		t.Fatal(err)
	}

	lease, err := provider.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	boot := journal.BootID{1, 2, 3}
	bootStart, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 180_000})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := journal.PrepareAnchor(journal.Anchor{
		Boot:           boot,
		ClockSegment:   1,
		ElapsedMs:      180_000,
		UTCMs:          1_800_000_000_000,
		EvidenceID:     "schema-contract",
		EvidenceSource: "fixture",
	})
	if err != nil {
		t.Fatal(err)
	}

	load, err := journal.PrepareSample(journal.Sample{
		Boot:         boot,
		ClockSegment: 1,
		Series:       1,
		ElapsedMs:    180_000,
		Values:       []journal.Value{{Known: true, V: 20}, {Known: true, V: 40}},
	})
	if err != nil {
		t.Fatal(err)
	}

	temp, err := journal.PrepareSample(journal.Sample{
		Boot:         boot,
		ClockSegment: 1,
		Series:       2,
		ElapsedMs:    180_000,
		Values:       []journal.Value{{Known: true, V: 42_000}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Append(ctx, []journal.Record{bootStart, anchor, load, temp}); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Sync(ctx); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	factory := &schemaRecordingFactory{}
	store, err := publication.NewDerivedStore(paths, factory, provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	factory.mu.Lock()

	specs := append([]schemaOpen(nil), factory.specs...)

	factory.mu.Unlock()

	var loadSeen, tempSeen bool

	for _, opened := range specs {
		spec := opened.spec

		switch filepath.Base(opened.path) {
		case "mndw-load-v1.rrd":
			loadSeen = true

			if !hasDataSourceNames(spec, "cpu", "ram") {
				t.Errorf("load schema data sources=%+v", spec.DS)
			}

			if spec.Step != 3*time.Minute || spec.Step != journal.StepForSeries(1) {
				t.Errorf("load schema step=%s", spec.Step)
			}
		case "mndw-temp-v1.rrd":
			tempSeen = true

			if !hasDataSourceNames(spec, "value") {
				t.Errorf("temperature schema data sources=%+v", spec.DS)

				continue
			}

			if spec.Step != 3*time.Minute || spec.Step != journal.StepForSeries(2) {
				t.Errorf("temperature schema step=%s", spec.Step)
			}

			if spec.DS[0].Min == nil || *spec.DS[0].Min != -100_000 {
				t.Errorf("temperature minimum=%v", spec.DS[0].Min)
			}

			if spec.DS[0].Max == nil || *spec.DS[0].Max != 250_000 {
				t.Errorf("temperature maximum=%v", spec.DS[0].Max)
			}
		}
	}

	if !loadSeen || !tempSeen {
		t.Fatalf("recovery did not open both destination series: load=%v temp=%v opens=%d", loadSeen, tempSeen, len(specs))
	}
}

func hasDataSourceNames(spec rrd.CreateSpec, names ...string) bool {
	if len(spec.DS) != len(names) {
		return false
	}

	for i, name := range names {
		if spec.DS[i].Name != name {
			return false
		}
	}

	return true
}
