package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// lockFileName is the storage ownership lock inside JournalDir.
const lockFileName = "journal.lock"

// Recovery issue codes reported to callers and diagnostics.
const (
	issueLockBusy       = "lock-busy"
	issueManifestLost   = "manifest-missing"
	issueManifestBad    = "manifest-corrupt"
	issueSegmentDamaged = "segment-corrupt"
	issueRecovered      = "recovered-unproven"
	issueInitPending    = "initialization-incomplete"
)

// ErrRetiring reports that a provider generation is being replaced, so no new
// lease can start against it.
var ErrRetiring = errors.New("journal: storage generation is retiring")

// ErrProviderClosed reports that the provider is closed.
var ErrProviderClosed = errors.New("journal: storage provider is closed")

// Storage owns the exclusive storage lock and the writable journal inventory.
type Storage struct {
	paths     StoragePaths
	fs        FileSystem
	locker    Locker
	lock      LockHandle
	limits    Limits
	exclusive bool

	mu             sync.Mutex
	manifest       Manifest
	active         *openSegment
	activeBoot     BootID
	bootOrder      uint64
	nextSequence   uint64
	lastSequence   uint64
	durableThrough uint64
	needsRepair    bool
	manifestDirty  bool
	closed         bool
	pins           int
	scratchBytes   int64
	retention      RetentionInput
	pendingLoss    map[LossReason]uint64
}

// Paths returns the storage location.
func (s *Storage) Paths() StoragePaths { return s.paths }

// Manifest returns a copy of the committed inventory.
func (s *Storage) Manifest() Manifest {
	s.mu.Lock()

	defer s.mu.Unlock()

	manifest := s.manifest
	manifest.Segments = append([]SegmentEntry(nil), s.manifest.Segments...)

	return manifest
}

// DurableThrough is the runtime high-water sequence of synchronized records.
func (s *Storage) DurableThrough() uint64 {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.durableThrough
}

// Close seals the active segment, publishes the inventory, and releases the
// exclusive lock. It is idempotent.
func (s *Storage) Close() error {
	s.mu.Lock()

	defer s.mu.Unlock()

	if s.closed {
		return nil
	}

	if s.active != nil && !s.active.sealed {
		segment := s.active
		_ = segment.file.Sync()
		_ = segment.file.Close()
		segment.sealed = true

		for i := range s.manifest.Segments {
			if s.manifest.Segments[i].Name == segment.name {
				s.manifest.Segments[i].Sealed = true
				s.manifest.Segments[i].Bytes = segment.size
			}
		}

		s.manifestDirty = true
	}

	if s.manifestDirty {
		_ = writeManifest(s.fs, manifestPath(s.paths), s.manifest)
		s.manifestDirty = false
	}

	s.closed = true

	if s.lock != nil {
		return s.lock.Close()
	}

	return nil
}

// Reader scans a validated inventory. A read-only reader owns a shared lock for
// its whole lifetime so compaction or append cannot change the files it reads.
// A reader created from a writable storage shares that writer's exclusive
// ownership and must not release it.
type Reader struct {
	paths   StoragePaths
	fs      FileSystem
	lock    LockHandle
	segment []string
	// live resolves the inventory at scan time for readers that share a
	// writable storage's exclusive ownership.
	live *Storage

	mu     sync.Mutex
	closed bool
}

// Scan visits every complete validated record in inventory order. It stops at
// the first incomplete or damaged frame and never repairs or truncates.
func (r *Reader) Scan(ctx context.Context, visit func(Record) error) error {
	if visit == nil {
		return errors.New("journal: scan requires a visitor")
	}

	names := r.segment

	if r.live != nil {
		manifest := r.live.Manifest()
		names = make([]string, 0, len(manifest.Segments))

		for _, entry := range manifest.Segments {
			names = append(names, entry.Name)
		}
	}

	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return err
		}

		if err := r.scanSegment(name, visit); err != nil {
			return err
		}
	}

	return nil
}

// ScanAfter visits records in (after, through] without opening complete
// segments whose sequence range ends at or before after. A zero through means
// the current validated inventory end.
func (r *Reader) ScanAfter(ctx context.Context, after, through uint64, visit func(Record) error) error {
	if visit == nil {
		return errors.New("journal: scan requires a visitor")
	}

	if through > 0 && after >= through {
		return nil
	}

	if r.live == nil {
		for _, name := range r.segment {
			if err := ctx.Err(); err != nil {
				return err
			}

			if err := scanSegmentFileAfter(r.fs, filepath.Join(r.paths.JournalDir, name), after, through, visit); err != nil {
				return err
			}
		}

		return nil
	}

	segments := r.live.Manifest().Segments

	for index, entry := range segments {
		if err := ctx.Err(); err != nil {
			return err
		}

		if through > 0 && entry.FirstSequence > through {
			continue
		}

		if index+1 < len(segments) {
			nextFirst := segments[index+1].FirstSequence

			if nextFirst > 0 && after >= nextFirst-1 {
				continue
			}
		}

		if err := scanSegmentFileAfter(r.fs, filepath.Join(r.paths.JournalDir, entry.Name), after, through, visit); err != nil {
			return err
		}
	}

	return nil
}

func (r *Reader) scanSegment(name string, visit func(Record) error) error {
	file, err := r.fs.OpenFile(filepath.Join(r.paths.JournalDir, name), os.O_RDONLY, 0)
	if err != nil {
		return err
	}

	defer func() { _ = file.Close() }()

	if _, err := DecodeHeader(file); err != nil {
		return err
	}

	for {
		record, err := DecodeRecord(file)
		if err != nil {
			if errors.Is(err, ErrTruncatedTail) || errors.Is(err, ErrChecksum) || errors.Is(err, ErrRecordLength) {
				return nil
			}

			return err
		}

		if err := visit(record); err != nil {
			return err
		}
	}
}

// Close releases the reader's shared lock, if it owns one.
func (r *Reader) Close() error {
	r.mu.Lock()

	defer r.mu.Unlock()

	if r.closed {
		return nil
	}

	r.closed = true

	if r.lock != nil {
		return r.lock.Close()
	}

	return nil
}

// OpenStorage opens or initializes journal storage and returns an explicit
// recovery outcome. It is the only constructor that can return a writer.
func OpenStorage(ctx context.Context, paths StoragePaths, fs FileSystem, locker Locker, limits Limits) (OpenResult, error) {
	if err := validateOpenArgs(paths, fs, locker); err != nil {
		return OpenResult{}, err
	}

	if err := ctx.Err(); err != nil {
		return OpenResult{}, err
	}

	if limits.Bytes <= 0 {
		limits = DefaultLimits()
	}

	if err := fs.MkdirAll(paths.JournalDir, 0o755); err != nil {
		return OpenResult{}, err
	}

	lock, err := locker.Acquire(ctx, filepath.Join(paths.JournalDir, lockFileName), LockExclusive)
	if err != nil {
		return OpenResult{Status: RecoveryStatus{Mode: StatusUnavailable, Issues: []RecoveryIssue{{Code: issueLockBusy}}}}, nil
	}

	manifest, manifestErr := loadManifest(fs, manifestPath(paths))
	artifacts, err := hasJournalArtifacts(fs, paths)
	if err != nil {
		_ = lock.Close()

		return OpenResult{}, err
	}

	switch {
	case manifestErr == nil:
	case errors.Is(manifestErr, os.ErrNotExist) && !artifacts:
		manifest, err = initializeStorage(fs, paths)
		if err != nil {
			_ = lock.Close()

			return OpenResult{}, err
		}
	case errors.Is(manifestErr, os.ErrNotExist):
		return downgradeToSalvage(ctx, paths, fs, locker, lock, issueManifestLost)
	default:
		return downgradeToSalvage(ctx, paths, fs, locker, lock, issueManifestBad)
	}

	if manifest.State == stateInitializing {
		// Older alpha versions wrote this state while deleting RRD files. The
		// new runtime preserves those files and only completes the manifest
		// transition.
		manifest.State = stateReady

		if err := writeManifest(fs, manifestPath(paths), manifest); err != nil {
			_ = lock.Close()

			return OpenResult{}, err
		}
	}

	storage := &Storage{
		paths:     paths,
		fs:        fs,
		locker:    locker,
		lock:      lock,
		limits:    limits,
		exclusive: true,
		manifest:  manifest,
	}

	// A writable open validates retained frames and promotes them with one
	// recovery sync before any derived publication may run.
	issues, err := recoverWritableStorage(ctx, storage)
	if err != nil {
		_ = storage.Close()

		return salvageAfterFailure(ctx, paths, fs, locker, issueRecovered)
	}

	return OpenResult{
		Writer: storage,
		Reader: storage.reader(),
		Status: RecoveryStatus{Mode: StatusReady, Issues: issues},
	}, nil
}

// OpenReadOnly inspects journal storage without initializing, repairing, or
// truncating anything. It holds a shared lock for the reader's lifetime.
func OpenReadOnly(ctx context.Context, paths StoragePaths, fs FileSystem, locker Locker) (ReadResult, error) {
	if err := validateOpenArgs(paths, fs, locker); err != nil {
		return ReadResult{}, err
	}

	if err := ctx.Err(); err != nil {
		return ReadResult{}, err
	}

	// An absent journal directory means there is nothing to inspect. Reporting
	// an empty reader keeps inspection read-only: no directory, lock, or
	// manifest is created.
	if _, err := fs.Stat(paths.JournalDir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ReadResult{
				Reader: &Reader{paths: paths, fs: fs},
				Status: RecoveryStatus{Mode: StatusReady},
			}, nil
		}

		return ReadResult{}, err
	}

	lock, err := locker.Acquire(ctx, filepath.Join(paths.JournalDir, lockFileName), LockShared)
	if err != nil {
		return ReadResult{Status: RecoveryStatus{Mode: StatusUnavailable, Issues: []RecoveryIssue{{Code: issueLockBusy}}}}, nil
	}

	names, err := segmentNamesFromDir(fs, paths.JournalDir)
	if err != nil {
		_ = lock.Close()

		return ReadResult{}, err
	}

	reader := &Reader{paths: paths, fs: fs, lock: lock, segment: names}

	return ReadResult{Reader: reader, Status: RecoveryStatus{Mode: StatusReady}}, nil
}

func checkLockMode(mode LockMode) error {
	switch mode {
	case LockShared, LockExclusive:
		return nil
	default:
		return errors.New("journal: unknown lock mode")
	}
}

func validateOpenArgs(paths StoragePaths, fs FileSystem, locker Locker) error {
	if fs == nil || locker == nil {
		return errors.New("journal: filesystem and locker are required")
	}

	if paths.RRDDir == "" || paths.JournalDir == "" {
		return ErrInvalidPaths
	}

	if filepath.Dir(paths.JournalDir) != paths.RRDDir {
		return ErrInvalidPaths
	}

	return nil
}

// downgradeToSalvage releases the exclusive lock and reopens storage read-only
// for bounded validated salvage.
func downgradeToSalvage(ctx context.Context, paths StoragePaths, fs FileSystem, locker Locker, exclusive LockHandle, code string) (OpenResult, error) {
	if exclusive != nil {
		if err := exclusive.Close(); err != nil {
			return OpenResult{}, err
		}
	}

	return salvageAfterFailure(ctx, paths, fs, locker, code)
}

// salvageAfterFailure reports bounded read-only salvage when a writable open
// could not publish recovered frames.
func salvageAfterFailure(ctx context.Context, paths StoragePaths, fs FileSystem, locker Locker, code string) (OpenResult, error) {
	result, err := OpenReadOnly(ctx, paths, fs, locker)
	if err != nil {
		return OpenResult{}, err
	}

	issues := []RecoveryIssue{{Code: code}}

	if result.Reader == nil {
		return OpenResult{Status: RecoveryStatus{Mode: StatusUnavailable, Issues: issues}}, nil
	}

	if len(result.Reader.segment) == 0 {
		_ = result.Reader.Close()

		return OpenResult{Status: RecoveryStatus{Mode: StatusUnavailable, Issues: issues}}, nil
	}

	status := RecoveryStatus{Mode: StatusReadOnly, Issues: append(issues, result.Status.Issues...)}

	return OpenResult{Reader: result.Reader, Status: status}, nil
}

// validateInventory checks every committed segment header and reports frames
// whose durability is unproven after a restart.
func validateInventory(fs FileSystem, paths StoragePaths, manifest Manifest) ([]RecoveryIssue, error) {
	var issues []RecoveryIssue

	for _, entry := range manifest.Segments {
		file, err := fs.OpenFile(filepath.Join(paths.JournalDir, entry.Name), os.O_RDONLY, 0)
		if err != nil {
			issues = append(issues, RecoveryIssue{Code: issueSegmentDamaged})

			continue
		}

		_, headerErr := DecodeHeader(file)
		closeErr := file.Close()

		if headerErr != nil {
			issues = append(issues, RecoveryIssue{Code: issueSegmentDamaged})

			continue
		}

		if closeErr != nil {
			return nil, closeErr
		}
	}

	if len(manifest.Segments) > 0 {
		// DurableThrough is a runtime watermark and is not persisted, so any
		// complete frame found after a restart is recovered-unproven until a
		// writable recovery sync promotes it.
		issues = append(issues, RecoveryIssue{Code: issueRecovered})
	}

	return issues, nil
}

func segmentNamesFromDir(fs FileSystem, dir string) ([]string, error) {
	entries, err := fs.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}

		return nil, err
	}

	return segmentNames(entries), nil
}

// reader returns a non-owning view of the writer's committed inventory.
func (s *Storage) reader() *Reader {
	s.mu.Lock()

	defer s.mu.Unlock()

	names := make([]string, 0, len(s.manifest.Segments))

	for _, entry := range s.manifest.Segments {
		names = append(names, entry.Name)
	}

	return &Reader{paths: s.paths, fs: s.fs, segment: names, live: s}
}

// provider is the reattachable storage provider owned by the capability.
type provider struct {
	paths  StoragePaths
	fs     FileSystem
	locker Locker
	limits Limits

	mu         sync.Mutex
	current    OpenResult
	generation uint64
	refs       int
	retiring   bool
	closed     bool
	idle       chan struct{}
}

// NewStorageProvider returns the reattachable provider used by the daemon. It
// does not open storage until Acquire or Reopen is called.
func NewStorageProvider(paths StoragePaths, fs FileSystem, locker Locker, limits Limits) (StorageProvider, error) {
	if err := validateOpenArgs(paths, fs, locker); err != nil {
		return nil, err
	}

	if limits.Bytes <= 0 {
		limits = DefaultLimits()
	}

	return &provider{paths: paths, fs: fs, locker: locker, limits: limits, idle: make(chan struct{}, 1)}, nil
}

// CurrentStatus reports status only and never grants a handle.
func (p *provider) CurrentStatus() RecoveryStatus {
	p.mu.Lock()

	defer p.mu.Unlock()

	return p.current.Status
}

// Acquire leases the latest snapshot for the duration of one operation.
func (p *provider) Acquire(_ context.Context) (StorageLease, error) {
	p.mu.Lock()

	defer p.mu.Unlock()

	if p.closed {
		return StorageLease{}, ErrProviderClosed
	}

	if p.retiring {
		return StorageLease{}, ErrRetiring
	}

	p.refs++

	return StorageLease{Result: p.current, provider: p, generation: p.generation}, nil
}

// Reopen marks the current generation retiring, waits for outstanding leases,
// then validates and reacquires storage without resetting any file.
func (p *provider) Reopen(ctx context.Context) (OpenResult, error) {
	if err := p.beginRetirement(); err != nil {
		return OpenResult{}, err
	}

	if err := p.awaitIdle(ctx); err != nil {
		p.mu.Lock()

		p.retiring = false

		p.mu.Unlock()

		return p.snapshot(), err
	}

	// Retired handles and their locks are released before storage is
	// revalidated, otherwise the new open competes with the old lock.
	p.mu.Lock()
	p.closeHandlesLocked()

	p.current = OpenResult{}

	p.mu.Unlock()

	opened, err := OpenStorage(ctx, p.paths, p.fs, p.locker, p.limits)
	if err != nil {
		p.mu.Lock()

		p.retiring = false

		p.mu.Unlock()

		return p.snapshot(), err
	}

	p.mu.Lock()

	p.current = opened
	p.generation++
	p.retiring = false

	p.mu.Unlock()

	return opened, nil
}

// Close waits for outstanding leases and releases every handle.
func (p *provider) Close(ctx context.Context) error {
	p.mu.Lock()

	if p.closed {
		p.mu.Unlock()

		return nil
	}

	p.closed = true
	p.retiring = true

	p.mu.Unlock()

	if err := p.awaitIdle(ctx); err != nil {
		return err
	}

	p.mu.Lock()

	defer p.mu.Unlock()

	p.closeHandlesLocked()

	return nil
}

func (p *provider) beginRetirement() error {
	p.mu.Lock()

	defer p.mu.Unlock()

	if p.closed {
		return ErrProviderClosed
	}

	if p.retiring {
		return ErrRetiring
	}

	p.retiring = true

	return nil
}

func (p *provider) awaitIdle(ctx context.Context) error {
	for {
		p.mu.Lock()

		refs := p.refs

		p.mu.Unlock()

		if refs == 0 {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.idle:
		}
	}
}

func (p *provider) closeHandlesLocked() {
	if p.current.Writer != nil {
		_ = p.current.Writer.Close()
	}

	if p.current.Reader != nil {
		_ = p.current.Reader.Close()
	}
}

func (p *provider) snapshot() OpenResult {
	p.mu.Lock()

	defer p.mu.Unlock()

	return p.current
}

// release drops one lease reference and wakes a waiting retirement.
func (p *provider) release(generation uint64) {
	p.mu.Lock()

	defer p.mu.Unlock()

	if generation != p.generation {
		return
	}

	if p.refs > 0 {
		p.refs--
	}

	if p.refs == 0 {
		select {
		case p.idle <- struct{}{}:
		default:
		}
	}
}

// Close releases one provider generation reference exactly once.
func (l *StorageLease) Close() error {
	if l.provider == nil {
		return nil
	}

	provider := l.provider
	l.provider = nil

	provider.release(l.generation)

	return nil
}
