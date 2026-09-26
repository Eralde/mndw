package sessions

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/telemetry/journal"
)

func TestSessionLimitRejectsUnboundedPage(t *testing.T) {
	if _, err := ParseSessionLimit(url.Values{"limit": {"1001"}}); err == nil {
		t.Fatal("accepted page above bound")
	}

	if _, err := ParseSessionLimit(url.Values{"limit": {"0"}}); err == nil {
		t.Fatal("accepted zero page")
	}

	if limit, err := ParseSessionLimit(url.Values{"limit": {"1000"}}); err != nil || limit != 1000 {
		t.Fatalf("limit=%d err=%v", limit, err)
	}

	if limit, err := ParseSessionLimit(url.Values{}); err != nil || limit != defaultSessionPage {
		t.Fatalf("default limit=%d err=%v", limit, err)
	}

	if _, err := ParseSessionLimit(url.Values{"limit": {"10", "20"}}); err == nil {
		t.Fatal("accepted repeated limit")
	}

	if _, err := ParseSessionLimit(url.Values{"limit": {"10"}, "nope": {"1"}}); err == nil {
		t.Fatal("accepted unknown query parameter")
	}
}

func TestSessionIDRoundTrip(t *testing.T) {
	boot := journal.BootID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	id := SessionID(boot)

	if !strings.HasPrefix(id, sessionIDPrefix) || len(id) != len(sessionIDPrefix)+32 {
		t.Fatalf("id=%q", id)
	}

	parsed, err := ParseSessionID(id)
	if err != nil {
		t.Fatal(err)
	}

	if parsed != boot {
		t.Fatalf("parsed=%s", parsed)
	}

	for _, invalid := range []string{"", "s1-", "s2-" + boot.String(), sessionIDPrefix + "zz" + boot.String()[2:], sessionIDPrefix + boot.String()[:31]} {
		if _, err := ParseSessionID(invalid); !errors.Is(err, ErrSessionNotFound) {
			t.Fatalf("%q accepted", invalid)
		}
	}
}

func TestCursorEncodingIsCanonicalAndTamperEvident(t *testing.T) {
	boot := journal.BootID{7}
	original := cursor{boot: boot, inventoryGeneration: 3, nextSequence: 42, snapshotThrough: 100}
	encoded := encodeCursor(original)

	if len(encoded) != 60 {
		t.Fatalf("cursor length=%d", len(encoded))
	}

	decoded, err := decodeCursor(encoded, boot)
	if err != nil {
		t.Fatal(err)
	}

	if decoded != original {
		t.Fatalf("decoded=%+v", decoded)
	}

	if _, err := decodeCursor(encoded, journal.BootID{8}); !errors.Is(err, ErrCursorInvalid) {
		t.Fatal("cursor accepted for another session")
	}

	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}

	raw[30] ^= 1

	if _, err := decodeCursor(base64.RawURLEncoding.EncodeToString(raw), boot); !errors.Is(err, ErrCursorInvalid) {
		t.Fatal("damaged cursor accepted")
	}

	if _, err := decodeCursor("short", boot); !errors.Is(err, ErrCursorInvalid) {
		t.Fatal("short cursor accepted")
	}
}

func seedSessionJournal(t *testing.T) (journal.StorageProvider, journal.BootID) {
	t.Helper()

	return seedSessionJournalAt(t, t.TempDir())
}

func seedSessionJournalAt(t *testing.T, rrdDir string) (journal.StorageProvider, journal.BootID) {
	t.Helper()

	paths, err := journal.PathsFromRRDDir(rrdDir)
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

	boot := journal.BootID{1, 2, 3}
	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	bootStart, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ElapsedMs: 0, UTCMs: 1800000000000, EvidenceID: "ev", EvidenceSource: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	known, err := journal.PrepareSample(journal.Sample{Boot: boot, Series: 1, ElapsedMs: 0, Values: []journal.Value{{Known: true, V: 20}, {Known: false}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Append(context.Background(), []journal.Record{bootStart, anchor, known}); err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	return provider, boot
}

func TestSessionReadSalvagesWithoutWriter(t *testing.T) {
	rrdDir := t.TempDir()
	provider, boot := seedSessionJournalAt(t, rrdDir)
	if err := provider.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	paths, err := journal.PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(paths.JournalDir, "manifest.json")); err != nil {
		t.Fatal(err)
	}

	salvage, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = salvage.Close(context.Background()) }()

	opened, err := salvage.Reopen(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != journal.StatusReadOnly || opened.Reader == nil || opened.Writer != nil {
		t.Fatalf("salvage outcome=%+v", opened)
	}

	reader := NewReader(salvage, func() Status { return Status{} }, journal.DefaultLimits())
	page, err := reader.Read(context.Background(), SessionID(boot), "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Samples) != 1 || page.Samples[0].Disposition != "unproven" {
		t.Fatalf("salvaged samples=%+v", page.Samples)
	}
}

func TestSessionListReportsRetainedBoot(t *testing.T) {
	provider, boot := seedSessionJournal(t)

	defer func() { _ = provider.Close(context.Background()) }()

	reader := NewReader(provider, func() Status { return Status{} }, journal.DefaultLimits())
	list, err := reader.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(list.Sessions) != 1 {
		t.Fatalf("sessions=%+v", list.Sessions)
	}

	session := list.Sessions[0]

	if session.ID != SessionID(boot) {
		t.Fatalf("id=%s", session.ID)
	}

	if session.SampleCount != 1 || session.State != "anchored" {
		t.Fatalf("session=%+v", session)
	}

	if session.UTCStartMs == nil || *session.UTCStartMs != 1800000000000 {
		t.Fatalf("utc=%v", session.UTCStartMs)
	}

	if list.Storage.Mode != string(journal.StatusReady) {
		t.Fatalf("storage=%+v", list.Storage)
	}

	if list.Storage.JournalLimitBytes != journal.DefaultLimits().Bytes {
		t.Fatalf("limit=%d", list.Storage.JournalLimitBytes)
	}
}

func TestSessionReadPaginatesAndReportsNullUnknowns(t *testing.T) {
	provider, boot := seedSessionJournal(t)

	defer func() { _ = provider.Close(context.Background()) }()

	reader := NewReader(provider, func() Status { return Status{} }, journal.DefaultLimits())
	page, err := reader.Read(context.Background(), SessionID(boot), "", 0)
	if err != nil {
		t.Fatal(err)
	}

	if len(page.Samples) != 1 {
		t.Fatalf("samples=%+v", page.Samples)
	}

	sample := page.Samples[0]

	if sample.UTCMs == nil || *sample.UTCMs != 1800000000000 {
		t.Fatalf("utc=%v", sample.UTCMs)
	}

	if len(sample.Values) != 2 || sample.Values[0] == nil || sample.Values[1] != nil {
		t.Fatalf("values=%v", sample.Values)
	}

	if sample.Disposition != "retained" {
		t.Fatalf("disposition=%s", sample.Disposition)
	}

	if page.Truncated {
		t.Fatalf("page=%+v", page)
	}

	if _, err := reader.Read(context.Background(), SessionID(journal.BootID{9}), "", 0); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unknown session: %v", err)
	}

	if _, err := reader.Read(context.Background(), SessionID(boot), "not-a-cursor", 0); !errors.Is(err, ErrCursorInvalid) {
		t.Fatalf("bad cursor: %v", err)
	}
}

func TestSessionReadRejectsStaleCursor(t *testing.T) {
	provider, boot := seedSessionJournal(t)

	defer func() { _ = provider.Close(context.Background()) }()

	reader := NewReader(provider, func() Status { return Status{} }, journal.DefaultLimits())
	lease, err := acquireReadLease(context.Background(), provider)
	if err != nil {
		t.Fatal(err)
	}

	stale := encodeCursor(cursor{boot: boot, inventoryGeneration: generationOf(lease), nextSequence: 1, snapshotThrough: 1})
	_ = lease.close()

	if _, err := reader.Read(context.Background(), SessionID(boot), stale, 0); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("stale cursor: %v", err)
	}
}
