package ttyd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProcessUsesPrivateLoopbackAndStopsOwnedGroup(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	bin := filepath.Join(dir, "ttyd")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + argsPath + "\"\nsleep 30\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	process := New(func(name string) string {
		if name == "MNDW_TTYD_BIN" {
			return bin
		}
		return ""
	})
	if err := process.Start(nil, "router"); err != nil {
		t.Fatal(err)
	}
	var args []byte
	var err error
	for attempt := 0; attempt < 100; attempt++ {
		args, err = os.ReadFile(argsPath)
		if err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "-i\n127.0.0.1\n-p\n7681") {
		t.Fatalf("ttyd args = %q", args)
	}
	if err := process.Stop(nil); err != nil {
		t.Fatal(err)
	}
	if process.command != nil {
		t.Fatal("owned ttyd command still recorded after stop")
	}
}
