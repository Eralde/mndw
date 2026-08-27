package backend

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateServiceLeaseRequiresFullSameBootIdentity(t *testing.T) {
	lease := ServiceLease{BootID: "boot-a", PID: 42, PGID: 42, StartTimeTicks: 99, ExecutablePath: "/plugins/demo/server", ExecutableDev: 1, ExecutableIno: 2}
	reader := fakeProcessReader{bootID: "boot-a", process: ProcessIdentity{PID: 42, PGID: 42, StartTimeTicks: 99, ExecutablePath: lease.ExecutablePath, ExecutableDev: 1, ExecutableIno: 2}}

	if matched, err := ValidateServiceLease(lease, reader); err != nil || !matched {
		t.Fatalf("full lease match = %v, %v", matched, err)
	}

	for name, change := range map[string]func(*fakeProcessReader){
		"boot mismatch":          func(r *fakeProcessReader) { r.bootID = "boot-b" },
		"pid reuse":              func(r *fakeProcessReader) { r.process.StartTimeTicks++ },
		"pgid mismatch":          func(r *fakeProcessReader) { r.process.PGID++ },
		"executable replacement": func(r *fakeProcessReader) { r.process.ExecutableIno++ },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := reader

			change(&candidate)

			matched, err := ValidateServiceLease(lease, candidate)
			if err != nil || matched {
				t.Fatalf("ValidateServiceLease = %v, %v, want false nil", matched, err)
			}
		})
	}
}

func TestWriteAndReadServiceLeaseIsAtomicAndPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.lease")
	want := ServiceLease{BootID: "boot", PID: 1, PGID: 1, StartTimeTicks: 2, ExecutablePath: "/bin/sh", ExecutableDev: 3, ExecutableIno: 4}

	if err := WriteServiceLease(path, want); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if info.Mode().Perm() != 0o600 {
		t.Fatalf("lease mode = %o", info.Mode().Perm())
	}

	got, err := ReadServiceLease(path)
	if err != nil {
		t.Fatal(err)
	}

	if got != want {
		t.Fatalf("lease = %#v, want %#v", got, want)
	}
}

type fakeProcessReader struct {
	bootID  string
	process ProcessIdentity
}

func (r fakeProcessReader) BootID() (string, error) { return r.bootID, nil }

func (r fakeProcessReader) ProcessIdentity(pid int) (ProcessIdentity, error) {
	if pid != r.process.PID {
		return ProcessIdentity{}, os.ErrNotExist
	}

	return r.process, nil
}
