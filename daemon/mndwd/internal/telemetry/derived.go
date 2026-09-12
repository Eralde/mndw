package telemetry

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

// ErrDerivedUnavailable reports that derived output cannot be mutated: storage
// is read-only or unavailable, or the RRDtool binary is missing.
var ErrDerivedUnavailable = errors.New("telemetry: derived storage unavailable")

// RRDFile is the destination-file surface owned by go-rrd.
type RRDFile interface {
	Ensure(context.Context, time.Time) error
	Update(context.Context, []rrd.UpdatePoint) error
	LastUpdate(context.Context) (time.Time, error)
	FetchGroup(context.Context, []rrd.FetchRequest) ([]rrd.FetchResult, error)
}

// RRDFactory opens a destination file. Ops injection keeps scratch allocation,
// install, and rename under daemon control.
type RRDFactory interface {
	Open(path string, spec rrd.CreateSpec, ops rrd.FileOps) (RRDFile, error)
}

// RRDtoolFactory is the production factory over the standalone binary.
type RRDtoolFactory struct {
	Executor rrd.Executor
}

// Open builds a destination file with the supplied file operations.
func (f RRDtoolFactory) Open(path string, spec rrd.CreateSpec, ops rrd.FileOps) (RRDFile, error) {
	if f.Executor == nil {
		return nil, ErrDerivedUnavailable
	}

	return rrd.NewFile(f.Executor, path, spec, rrd.WithFileOps(ops))
}

// destination is one derived RRD file and its publication frontier.
type destination struct {
	series  uint16
	path    string
	spec    rrd.CreateSpec
	file    RRDFile
	slotMs  int64
	rebuilt bool
	factory RRDFactory
	fs      journal.FileSystem
}

// Ensure creates or validates the destination file.
func (d *destination) Ensure(ctx context.Context, enable time.Time) error {
	if err := d.open(); err != nil {
		return err
	}

	return d.file.Ensure(ctx, enable)
}

// Update applies a bounded page of points to the destination file.
func (d *destination) Update(ctx context.Context, points []rrd.UpdatePoint) error {
	if err := d.open(); err != nil {
		return err
	}

	return d.file.Update(ctx, points)
}

// open lazily opens the destination handle.
func (d *destination) open() error {
	if d.file != nil {
		return nil
	}

	if d.factory == nil {
		return ErrDerivedUnavailable
	}

	file, err := d.factory.Open(d.path, d.spec, fileOpsAdapter{fs: d.fs})
	if err != nil {
		return err
	}

	d.file = file

	return nil
}

// DerivedStore owns rebuild transactions, destination serialization, and the
// clean-shutdown checkpoint.
type DerivedStore struct {
	paths   journal.StoragePaths
	factory RRDFactory
	storage journal.StorageProvider
	fs      journal.FileSystem
	logger  loggerFunc

	mu           sync.Mutex
	closeMu      sync.Mutex
	destinations map[uint16]*destination
	generation   uint64
	publication  uint64
	mutated      bool
	recovered    bool
}

type loggerFunc func(string, ...any)

// NewDerivedStore builds the derived publication worker.
func NewDerivedStore(
	paths journal.StoragePaths,
	factory RRDFactory,
	storage journal.StorageProvider,
	fs journal.FileSystem,
) (*DerivedStore, error) {
	if factory == nil || storage == nil {
		return nil, errors.New("telemetry: derived store needs a factory and storage provider")
	}

	if fs == nil {
		fs = journal.OSFileSystem{}
	}

	store := &DerivedStore{
		paths:        paths,
		factory:      factory,
		storage:      storage,
		fs:           fs,
		destinations: map[uint16]*destination{},
	}

	for series, spec := range map[uint16]rrd.CreateSpec{1: loadSpec(), 2: tempSpec()} {
		name := loadFileName

		if series == 2 {
			name = tempFileName
		}

		store.destinations[series] = &destination{
			series:  series,
			path:    filepath.Join(paths.RRDDir, name),
			spec:    spec,
			factory: factory,
			fs:      fs,
		}
	}

	return store, nil
}

// Progress reports the per-series publication frontier.
func (d *DerivedStore) Progress() map[uint16]int64 {
	d.mu.Lock()

	defer d.mu.Unlock()

	progress := make(map[uint16]int64, len(d.destinations))

	for series, destination := range d.destinations {
		progress[series] = destination.slotMs
	}

	return progress
}

// Recover validates the clean checkpoint and rebuilds derived files when their
// completeness is uncertain. It runs before any RunCycle.
func (d *DerivedStore) Recover(ctx context.Context) error {
	if err := d.cleanupRebuildScratch(ctx); err != nil {
		return err
	}

	checkpointPath, cleanPath := checkpointPaths(d.paths)

	checkpointPayloadBytes, checkpointErr := readFramedFile(d.fs, checkpointPath, kindCheckpoint)
	cleanPayloadBytes, cleanErr := readFramedFile(d.fs, cleanPath, kindClean)

	reusable := false

	if checkpointErr == nil && cleanErr == nil {
		marker, err := decodeCleanPayload(cleanPayloadBytes)
		if err == nil && marker.State == cleanStateValid {
			checkpoint, err := decodeCheckpointPayload(checkpointPayloadBytes)
			if err == nil && sha256Hex(checkpointPayloadBytes) == marker.CheckpointDigest {
				if attachErr := d.attachDestinations(); attachErr == nil {
					reusable = d.frontiersMatch(checkpoint)
				}
			}
		}
	}

	if reusable {
		d.mu.Lock()

		d.recovered = true
		d.mutated = false

		d.mu.Unlock()

		return d.attachDestinations()
	}

	// Any doubt requires a conservative rebuild, and the previous clean marker
	// is invalidated before an RRD is touched.
	if err := d.invalidateCleanMarker(cleanPath); err != nil {
		return err
	}

	if err := d.rebuildAll(ctx); err != nil {
		return err
	}

	d.mu.Lock()

	d.recovered = true

	d.mu.Unlock()

	return nil
}

// RunCycle publishes one cycle of durable records.
func (d *DerivedStore) RunCycle(ctx context.Context, cycle PublicationCycle) error {
	lease, err := d.storage.Acquire(ctx)
	if err != nil {
		return err
	}

	defer func() { _ = lease.Close() }()

	if lease.Result.Writer == nil || lease.Result.Reader == nil {
		return ErrDerivedUnavailable
	}

	d.mu.Lock()

	if !d.recovered {
		d.mu.Unlock()

		return errors.New("telemetry: derived store is not recovered")
	}

	d.mu.Unlock()

	boundary := journal.Publication{
		SampleThrough:   cycle.DurableThrough,
		CutoffElapsedMs: cycle.CutoffElapsedMs,
	}
	var prior journal.Publication

	if err := readerScanPublications(lease.Result.Reader, ctx, &prior); err != nil {
		return err
	}

	d.mu.Lock()

	for series, destination := range d.destinations {
		boundary.Frontiers = append(boundary.Frontiers, journal.Frontier{Series: series, SlotMs: destination.slotMs})
	}

	d.mu.Unlock()
	sort.Slice(boundary.Frontiers, func(i, j int) bool { return boundary.Frontiers[i].Series < boundary.Frontiers[j].Series })

	reader := lease.Result.Reader

	// The prior boundary records what was already committed; its Frontiers
	// protect fixed slots. But the sample/anchor eligibility window must
	// extend to the current cycle's durable high-water mark so that records
	// acquired since the last publication are included.
	effective := prior
	effective.SampleThrough = boundary.SampleThrough
	effective.AnchorThrough = boundary.SampleThrough

	if err := PlanPublication(ctx, func(visit func(journal.Record) error) error {
		return reader.Scan(ctx, visit)
	}, effective, func(plan PublicationPlan) error {
		return d.Publish(ctx, plan)
	}); err != nil {
		return err
	}

	// Freeze the successful canonical boundary in the authoritative journal.
	d.mu.Lock()

	boundary.Frontiers = boundary.Frontiers[:0]

	for series, destination := range d.destinations {
		boundary.Frontiers = append(boundary.Frontiers, journal.Frontier{Series: series, SlotMs: destination.slotMs})
	}

	d.mu.Unlock()
	sort.Slice(boundary.Frontiers, func(i, j int) bool { return boundary.Frontiers[i].Series < boundary.Frontiers[j].Series })

	prepared, err := journal.PreparePublication(boundary)
	if err != nil {
		return err
	}

	appended, err := lease.Result.Writer.Append(ctx, []journal.Record{prepared})
	if err != nil || appended.Accepted != 1 {
		if err != nil {
			return err
		}

		return errors.New("telemetry: publication boundary was not appended")
	}

	if _, err := lease.Result.Writer.Sync(ctx); err != nil {
		return err
	}

	d.mu.Lock()

	d.publication = appended.LastSequence

	d.mu.Unlock()

	return nil
}

func readerScanPublications(reader *journal.Reader, ctx context.Context, latest *journal.Publication) error {
	return reader.Scan(ctx, func(record journal.Record) error {
		if record.Kind != journal.KindPublication {
			return nil
		}

		publication, err := journal.DecodePublication(record)
		if err != nil {
			return err
		}

		if publication.Seq >= latest.Seq {
			*latest = publication
		}

		return nil
	})
}

// Publish delivers one bounded page of canonical points.
func (d *DerivedStore) Publish(ctx context.Context, plan PublicationPlan) error {
	if plan.Points == nil {
		return nil
	}

	d.mu.Lock()

	if !d.recovered {
		d.mu.Unlock()

		return errors.New("telemetry: derived store is not recovered")
	}

	d.mutated = true

	d.mu.Unlock()

	for series, points := range plan.Points {
		destination, ok := d.destination(series)

		if !ok || len(points) == 0 {
			continue
		}

		if err := destination.Ensure(ctx, points[0].Timestamp); err != nil {
			return err
		}

		lastUpdate, err := destination.file.LastUpdate(ctx)
		if err != nil {
			return err
		}

		points = pointsAfter(points, lastUpdate)

		if len(points) == 0 {
			continue
		}

		if err := destination.Update(ctx, points); err != nil {
			return err
		}

		d.mu.Lock()

		destination.slotMs = points[len(points)-1].Timestamp.UnixMilli()

		d.mu.Unlock()
	}

	return nil
}

// pointsAfter filters a canonical, chronologically ordered page to timestamps
// that the destination has not persisted yet.
func pointsAfter(points []rrd.UpdatePoint, lastUpdate time.Time) []rrd.UpdatePoint {
	for index, point := range points {
		if point.Timestamp.After(lastUpdate) {
			return points[index:]
		}
	}

	return nil
}

// CloseClean synchronizes derived files and publishes a valid clean marker.
func (d *DerivedStore) CloseClean(ctx context.Context) error {
	d.closeMu.Lock()

	defer d.closeMu.Unlock()

	checkpointPath, cleanPath := checkpointPaths(d.paths)

	d.mu.Lock()

	d.generation++
	generation := d.generation
	frontiers := make([]frontierEntry, 0, len(d.destinations))

	for series, destination := range d.destinations {
		frontiers = append(frontiers, frontierEntry{Series: series, SlotMs: fmt.Sprintf("%d", destination.slotMs)})
	}

	sort.Slice(frontiers, func(i, j int) bool { return frontiers[i].Series < frontiers[j].Series })

	files := make([]fileEntry, 0, len(d.destinations))

	for _, destination := range d.destinations {
		if err := syncFile(d.fs, destination.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			d.mu.Unlock()

			return err
		}

		lastUpdateMs := int64(0)

		if destination.file != nil {
			if lastUpdate, err := destination.file.LastUpdate(ctx); err == nil {
				lastUpdateMs = lastUpdate.UnixMilli()
			}
		}

		files = append(files, fileEntry{
			Series:            destination.series,
			Basename:          filepath.Base(destination.path),
			SchemaFingerprint: schemaFingerprint(destination.spec),
			LastUpdateMs:      fmt.Sprintf("%d", lastUpdateMs),
			StatIdentity:      statIdentity(d.fs, destination.path),
		})
	}

	sort.Slice(files, func(i, j int) bool { return files[i].Series < files[j].Series })
	d.mu.Unlock()

	payload := checkpointPayload{
		Version:            "1",
		Generation:         fmt.Sprintf("%d", generation),
		PublicationThrough: fmt.Sprintf("%d", d.publication),
		Frontiers:          frontiers,
		Files:              files,
	}
	encoded, err := canonicalCheckpointJSON(payload)
	if err != nil {
		return err
	}

	if err := writeFramedFile(d.fs, checkpointPath, kindCheckpoint, encoded); err != nil {
		return err
	}

	digest, err := frontierDigest(frontiers)
	if err != nil {
		return err
	}

	clean := cleanPayload{
		State:            cleanStateValid,
		CheckpointDigest: sha256Hex(encoded),
		FrontierDigest:   digest,
	}
	cleanEncoded, err := canonicalCleanJSON(clean)
	if err != nil {
		return err
	}

	return writeFramedFile(d.fs, cleanPath, kindClean, cleanEncoded)
}

func (d *DerivedStore) destination(series uint16) (*destination, bool) {
	d.mu.Lock()

	defer d.mu.Unlock()

	destination, ok := d.destinations[series]

	return destination, ok
}

// attachDestinations opens the existing destination handles for reuse.
func (d *DerivedStore) attachDestinations() error {
	d.mu.Lock()

	defer d.mu.Unlock()

	for _, destination := range d.destinations {
		if destination.file != nil {
			continue
		}

		file, err := d.factory.Open(destination.path, destination.spec, fileOpsAdapter{fs: d.fs})
		if err != nil {
			return err
		}

		destination.file = file
		lastUpdate, err := file.LastUpdate(context.Background())
		if err != nil && !errors.Is(err, rrd.ErrFileMissing) {
			return err
		}

		if err == nil {
			destination.slotMs = lastUpdate.UnixMilli()
		} else {
			destination.slotMs = 0
		}
	}

	return nil
}

// invalidateCleanMarker durably marks derived files as unclean before any RRD
// mutation.
func (d *DerivedStore) invalidateCleanMarker(cleanPath string) error {
	d.mu.Lock()

	d.generation++

	d.mu.Unlock()

	clean := cleanPayload{State: cleanStateInvalid}
	encoded, err := canonicalCleanJSON(clean)
	if err != nil {
		return err
	}

	return writeFramedFile(d.fs, cleanPath, kindClean, encoded)
}

// frontiersMatch reports whether the stored frontiers still match live state.
func (d *DerivedStore) frontiersMatch(checkpoint checkpointPayload) bool {
	d.mu.Lock()

	defer d.mu.Unlock()

	if len(checkpoint.Frontiers) != len(d.destinations) {
		return false
	}

	for _, frontier := range checkpoint.Frontiers {
		destination, ok := d.destinations[frontier.Series]

		if !ok {
			return false
		}

		if fmt.Sprintf("%d", destination.slotMs) != frontier.SlotMs {
			return false
		}
	}

	return true
}

// schemaFingerprint identifies a destination schema deterministically.
func schemaFingerprint(spec rrd.CreateSpec) string {
	digest := fmt.Sprintf("step=%d;ds=%d;rra=%d", spec.Step.Milliseconds(), len(spec.DS), len(spec.RRA))

	return sha256Hex([]byte(digest))
}

// statIdentity hashes the validated stat tuple of a destination file.
func statIdentity(fs journal.FileSystem, path string) string {
	info, err := fs.Stat(path)
	if err != nil {
		return ""
	}

	return sha256Hex([]byte(fmt.Sprintf("%s:%d", filepath.Base(path), info.Size())))
}

// fileOpsAdapter maps journal filesystem operations onto rrd.FileOps so scratch
// allocation, install, rename, and removal stay under daemon control.
type fileOpsAdapter struct {
	fs journal.FileSystem
}

// MkdirAll creates directories through the journal filesystem.
func (a fileOpsAdapter) MkdirAll(path string, perm os.FileMode) error {
	return a.fs.MkdirAll(path, perm)
}

// Stat stats through the journal filesystem.
func (a fileOpsAdapter) Stat(path string) (os.FileInfo, error) { return a.fs.Stat(path) }

// CreateTemp creates a temporary file through the journal filesystem.
func (a fileOpsAdapter) CreateTemp(dir, pattern string) (string, error) {
	file, err := a.fs.OpenFile(filepath.Join(dir, pattern), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}

	name := filepath.Join(dir, pattern)

	if err := file.Close(); err != nil {
		return "", err
	}

	return name, nil
}

// Link installs a scratch file at its destination without overwriting.
func (a fileOpsAdapter) Link(oldPath, newPath string) error {
	if _, err := a.fs.Stat(newPath); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	return a.fs.Rename(oldPath, newPath)
}

// Rename renames through the journal filesystem.
func (a fileOpsAdapter) Rename(oldPath, newPath string) error { return a.fs.Rename(oldPath, newPath) }

// Remove removes through the journal filesystem.
func (a fileOpsAdapter) Remove(path string) error { return a.fs.Remove(path) }
