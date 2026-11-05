package opkg

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTryLockExclusiveReportsBusy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	first, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	defer first.Close()

	second, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	defer second.Close()

	busy, err := tryLockExclusive(first)
	if err != nil || busy {
		t.Fatalf("first tryLockExclusive() = (%t, %v), want (false, nil)", busy, err)
	}

	busy, err = tryLockExclusive(second)
	if err != nil || !busy {
		t.Fatalf("second tryLockExclusive() = (%t, %v), want (true, nil)", busy, err)
	}

	if err := unlockFile(first); err != nil {
		t.Fatal(err)
	}

	busy, err = tryLockExclusive(second)
	if err != nil || busy {
		t.Fatalf("tryLockExclusive() after unlock = (%t, %v), want (false, nil)", busy, err)
	}

	if err := unlockFile(second); err != nil {
		t.Fatal(err)
	}
}
