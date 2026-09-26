package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

// fakeRRDFile records derived file operations.
type fakeRRDFile struct {
	path       string
	ensured    []time.Time
	updates    [][]rrd.UpdatePoint
	lastUpdate time.Time
	ensureErr  error
	updateErr  error
	created    bool
}

func (f *fakeRRDFile) Ensure(_ context.Context, enable time.Time) error {
	if f.ensureErr != nil {
		return f.ensureErr
	}

	if !f.created {
		f.created = true
	}

	f.ensured = append(f.ensured, enable)

	return nil
}

func (f *fakeRRDFile) Update(_ context.Context, points []rrd.UpdatePoint) error {
	if f.updateErr != nil {
		return f.updateErr
	}

	f.updates = append(f.updates, points)

	if len(points) > 0 {
		f.lastUpdate = points[len(points)-1].Timestamp
	}

	return nil
}

func (f *fakeRRDFile) LastUpdate(context.Context) (time.Time, error) { return f.lastUpdate, nil }

func (f *fakeRRDFile) FetchGroup(context.Context, []rrd.FetchRequest) ([]rrd.FetchResult, error) {
	return nil, nil
}

// fakeFactory records openings and hands back scripted files.
type fakeFactory struct {
	files     map[string]*fakeRRDFile
	opened    []string
	openOrder []string
}

func newFakeFactory() *fakeFactory {
	return &fakeFactory{files: map[string]*fakeRRDFile{}}
}

func (f *fakeFactory) Open(path string, _ rrd.CreateSpec, _ rrd.FileOps) (RRDFile, error) {
	// A real factory leaves a file behind, so filesystem barriers below have
	// something to synchronize and rename.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	if err := os.WriteFile(path, nil, 0o644); err != nil {
		return nil, err
	}

	f.opened = append(f.opened, path)
	f.openOrder = append(f.openOrder, path)

	if existing, ok := f.files[path]; ok {
		return existing, nil
	}

	created := &fakeRRDFile{path: path}
	f.files[path] = created

	return created, nil
}

func (f *fakeFactory) file(path string) *fakeRRDFile {
	return f.files[path]
}

func TestCheckpointFramingRoundTrip(t *testing.T) {
	payload := checkpointPayload{
		Version:            "1",
		Generation:         "7",
		PublicationThrough: "42",
		Frontiers:          []frontierEntry{{Series: 1, SlotMs: "1800000000000"}},
		Files: []fileEntry{{
			Series:            1,
			Basename:          loadFileName,
			SchemaFingerprint: "abc",
			LastUpdateMs:      "1800000000000",
			StatIdentity:      "def",
		}},
	}
	encoded, err := canonicalCheckpointJSON(payload)
	if err != nil {
		t.Fatal(err)
	}

	framed, err := encodeFramed(kindCheckpoint, encoded)
	if err != nil {
		t.Fatal(err)
	}

	if string(framed[:8]) != checkpointMagic {
		t.Fatalf("magic=%q", framed[:8])
	}

	decoded, err := decodeFramed(framed, kindCheckpoint)
	if err != nil {
		t.Fatal(err)
	}

	checkpoint, err := decodeCheckpointPayload(decoded)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.Generation != "7" || checkpoint.PublicationThrough != "42" || len(checkpoint.Frontiers) != 1 {
		t.Fatalf("checkpoint=%+v", checkpoint)
	}
}

func TestCheckpointCanonicalPayloadBytesAndRejectsAlternativeEncodings(t *testing.T) {
	payload := checkpointPayload{
		Version:            "1",
		Generation:         "7",
		PublicationThrough: "42",
		Frontiers:          []frontierEntry{{Series: 1, SlotMs: "1800000000000"}},
		Files: []fileEntry{{
			Series:            1,
			Basename:          loadFileName,
			SchemaFingerprint: "abc",
			LastUpdateMs:      "1800000000000",
			StatIdentity:      "def",
		}},
	}
	encoded, err := canonicalCheckpointJSON(payload)
	if err != nil {
		t.Fatal(err)
	}

	const expected = `{"files":[{"basename":"mndw-load-v1.rrd","lastUpdateMs":"1800000000000","schemaFingerprint":"abc","series":1,"statIdentity":"def"}],"frontiers":[{"series":1,"slotMs":"1800000000000"}],"generation":"7","journalInventoryGeneration":"","publicationThrough":"42","version":"1"}`

	if string(encoded) != expected {
		t.Fatalf("canonical payload = %s, want %s", encoded, expected)
	}

	reordered, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	for name, alternative := range map[string][]byte{
		"reordered keys":     reordered,
		"leading whitespace": append([]byte(" "), encoded...),
		"missing fields":     []byte(`{"version":"1"}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeCheckpointPayload(alternative); !errors.Is(err, ErrCheckpointInvalid) {
				t.Fatalf("alternative encoding accepted: %s (%v)", alternative, err)
			}
		})
	}

	fractionalSeries := []byte(strings.Replace(string(encoded), `"series":1`, `"series":1.0`, 1))

	if _, err := decodeCheckpointPayload(fractionalSeries); !errors.Is(err, ErrCheckpointInvalid) {
		t.Fatalf("fractional series accepted: %v", err)
	}
}

func TestCheckpointRejectsTamperingAndWrongKind(t *testing.T) {
	encoded, err := canonicalCleanJSON(cleanPayload{State: cleanStateValid, CheckpointDigest: "00", FrontierDigest: "11"})
	if err != nil {
		t.Fatal(err)
	}

	framed, err := encodeFramed(kindClean, encoded)
	if err != nil {
		t.Fatal(err)
	}

	corrupted := append([]byte(nil), framed...)
	corrupted[len(corrupted)-1] ^= 0xff

	if _, err := decodeFramed(corrupted, kindClean); !errors.Is(err, ErrCheckpointInvalid) {
		t.Fatalf("checksum tampering accepted: %v", err)
	}

	if _, err := decodeFramed(framed, kindCheckpoint); !errors.Is(err, ErrCheckpointInvalid) {
		t.Fatal("wrong kind accepted")
	}

	if _, err := decodeFramed(append([]byte(nil), framed[:8]...), kindClean); !errors.Is(err, ErrCheckpointInvalid) {
		t.Fatal("truncated frame accepted")
	}

	oversized := make([]byte, maxCheckpointPayload+1)

	if _, err := encodeFramed(kindCheckpoint, oversized); !errors.Is(err, ErrCheckpointInvalid) {
		t.Fatalf("oversized payload accepted: %v", err)
	}
}

func TestCheckpointRejectsUnknownKeys(t *testing.T) {
	document := map[string]any{
		"version": "1", "generation": "1", "journalInventoryGeneration": "1",
		"publicationThrough": "1", "frontiers": []any{}, "files": []any{}, "extra": true,
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := decodeCheckpointPayload(encoded); !errors.Is(err, ErrCheckpointInvalid) {
		t.Fatalf("unknown key accepted: %v", err)
	}
}

func TestCollectMappedRecordsIncludesSamplesBeforeAnchor(t *testing.T) {
	dir := t.TempDir()
	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	defer func() { _ = provider.Close(context.Background()) }()

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	boot := journal.BootID{1}
	sample, err := journal.PrepareSample(journal.Sample{Boot: boot, Series: 1, ElapsedMs: 0, Values: []journal.Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 60000, UTCMs: 1800000000000, EvidenceID: "ev", EvidenceSource: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Append(context.Background(), []journal.Record{sample, anchor}); err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	records, earliest, _, err := collectMappedRecords(context.Background(), lease.Result.Reader, 1)
	if err != nil {
		t.Fatal(err)
	}

	if earliest != 1799999940000 || len(records) != 2 {
		t.Fatalf("records=%d earliest=%d", len(records), earliest)
	}
}

func newJournalWithSamples(t *testing.T, dir string) (journal.StoragePaths, journal.StorageProvider) {
	t.Helper()

	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	boot := journal.BootID{1}
	bootStart, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ElapsedMs: 0, UTCMs: 1800000000000, EvidenceID: "ev", EvidenceSource: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	sample, err := journal.PrepareSample(journal.Sample{Boot: boot, Series: 1, ElapsedMs: 0, Values: []journal.Value{{Known: true, V: 20}, {Known: true, V: 40}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Append(context.Background(), []journal.Record{bootStart, anchor, sample}); err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	return paths, provider
}

func TestDerivedRecoverInvalidatesMarkerBeforeRebuild(t *testing.T) {
	dir := t.TempDir()
	paths, provider := newJournalWithSamples(t, dir)

	defer func() { _ = provider.Close(context.Background()) }()

	factory := newFakeFactory()
	store, err := NewDerivedStore(paths, factory, provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	_, cleanPath := checkpointPaths(paths)
	raw, err := os.ReadFile(cleanPath)
	if err != nil {
		t.Fatalf("clean marker not written: %v", err)
	}

	payload, err := decodeFramed(raw, kindClean)
	if err != nil {
		t.Fatal(err)
	}

	marker, err := decodeCleanPayload(payload)
	if err != nil {
		t.Fatal(err)
	}

	if marker.State != cleanStateInvalid {
		t.Fatalf("marker state=%q", marker.State)
	}

	// The scratch file is created before the destination is installed, and the
	// destination receives the ordered updates.
	found := false

	for _, path := range factory.opened {
		if filepath.Base(filepath.Dir(path)) != "" && filepath.Base(path) == "data.rrd" {
			found = true
		}
	}

	if !found {
		t.Fatalf("rebuild did not use a scratch file: %v", factory.opened)
	}

	if destination := factory.file(filepath.Join(paths.RRDDir, loadFileName)); destination == nil {
		t.Fatal("destination was not reopened after rebuild")
	}
}

func TestDerivedRebuildUsesEarliestMappedTime(t *testing.T) {
	dir := t.TempDir()
	paths, provider := newJournalWithSamples(t, dir)

	defer func() { _ = provider.Close(context.Background()) }()

	factory := newFakeFactory()
	store, err := NewDerivedStore(paths, factory, provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	scratch := factory.file(filepath.Join(filepath.Dir(paths.RRDDir), "unused"))
	_ = scratch

	for path, file := range factory.files {
		if filepath.Base(path) != "data.rrd" {
			continue
		}

		if len(file.ensured) == 0 {
			t.Fatalf("scratch %s was not created", path)
		}

		if got := file.ensured[0].UnixMilli(); got != 1800000000000 {
			t.Fatalf("ensure time=%d", got)
		}
	}
}

func TestDerivedCloseCleanPublishesValidMarker(t *testing.T) {
	dir := t.TempDir()
	paths, provider := newJournalWithSamples(t, dir)

	defer func() { _ = provider.Close(context.Background()) }()

	store, err := NewDerivedStore(paths, newFakeFactory(), provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := store.CloseClean(context.Background()); err != nil {
		t.Fatal(err)
	}

	checkpointPath, cleanPath := checkpointPaths(paths)
	checkpointRaw, err := os.ReadFile(checkpointPath)
	if err != nil {
		t.Fatal(err)
	}

	checkpointPayloadBytes, err := decodeFramed(checkpointRaw, kindCheckpoint)
	if err != nil {
		t.Fatal(err)
	}

	checkpoint, err := decodeCheckpointPayload(checkpointPayloadBytes)
	if err != nil {
		t.Fatal(err)
	}

	frontiers := append([]frontierEntry(nil), checkpoint.Frontiers...)

	sort.Slice(frontiers, func(i, j int) bool { return frontiers[i].Series < frontiers[j].Series })

	if len(frontiers) == 0 {
		t.Fatal("checkpoint has no frontiers")
	}

	cleanRaw, err := os.ReadFile(cleanPath)
	if err != nil {
		t.Fatal(err)
	}

	cleanBytes, err := decodeFramed(cleanRaw, kindClean)
	if err != nil {
		t.Fatal(err)
	}

	marker, err := decodeCleanPayload(cleanBytes)
	if err != nil {
		t.Fatal(err)
	}

	if marker.State != cleanStateValid {
		t.Fatalf("marker=%+v", marker)
	}

	if marker.CheckpointDigest != sha256Hex(checkpointPayloadBytes) {
		t.Fatal("clean marker does not reference the checkpoint digest")
	}
}

func TestDerivedRunCycleRequiresRecovery(t *testing.T) {
	dir := t.TempDir()
	paths, provider := newJournalWithSamples(t, dir)

	defer func() { _ = provider.Close(context.Background()) }()

	store, err := NewDerivedStore(paths, newFakeFactory(), provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.RunCycle(context.Background(), PublicationCycle{}); err == nil {
		t.Fatal("RunCycle before Recover accepted")
	}
}

func TestDerivedRunCyclePersistsPublicationBoundary(t *testing.T) {
	dir := t.TempDir()
	paths, provider := newJournalWithSamples(t, dir)

	defer func() { _ = provider.Close(context.Background()) }()

	store, err := NewDerivedStore(paths, newFakeFactory(), provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := store.RunCycle(context.Background(), PublicationCycle{CutoffElapsedMs: 180000, DurableThrough: 3}); err != nil {
		t.Fatal(err)
	}

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	found := false

	if err := lease.Result.Reader.Scan(context.Background(), func(record journal.Record) error {
		if record.Kind == journal.KindPublication {
			found = true
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if !found {
		t.Fatal("successful publication did not persist its boundary")
	}
}

func TestDerivedPublishSkipsExistingPoints(t *testing.T) {
	dir := t.TempDir()
	paths, provider := newJournalWithSamples(t, dir)

	defer func() { _ = provider.Close(context.Background()) }()

	factory := newFakeFactory()
	store, err := NewDerivedStore(paths, factory, provider, journal.OSFileSystem{})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	destination, ok := store.destination(1)

	if !ok {
		t.Fatal("load destination missing")
	}

	file := factory.file(destination.path)

	if file == nil {
		t.Fatal("load destination file missing")
	}

	existing := time.UnixMilli(1800000000000).UTC()
	file.lastUpdate = existing

	points := []rrd.UpdatePoint{
		{Timestamp: existing.Add(-3 * time.Minute), Values: []rrd.Value{rrd.Known(10), rrd.Known(20)}},
		{Timestamp: existing, Values: []rrd.Value{rrd.Known(30), rrd.Known(40)}},
		{Timestamp: existing.Add(3 * time.Minute), Values: []rrd.Value{rrd.Known(50), rrd.Known(60)}},
	}

	if err := store.Publish(context.Background(), PublicationPlan{Points: map[uint16][]rrd.UpdatePoint{1: points}}); err != nil {
		t.Fatal(err)
	}

	if len(file.updates) != 1 {
		t.Fatalf("update calls=%d, want 1", len(file.updates))
	}

	if len(file.updates[0]) != 1 || !file.updates[0][0].Timestamp.Equal(existing.Add(3*time.Minute)) {
		t.Fatalf("updated points=%+v", file.updates[0])
	}
}
