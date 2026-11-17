package opkg

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestExecInfoDerivesUpdateAvailableWithStringInequality(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg info curl":
			return "Package: curl\nVersion: 10-1\nDescription: Feed\nSize: 10\n", 0, nil
		case "opkg status curl":
			return "Package: curl\nVersion: 9-1\nStatus: install user installed\nInstalled-Size: 20\nInstalled-Time: 123\n", 0, nil
		case "opkg list-installed":
			return "curl - 9-1 - Installed\n", 0, nil
		case "opkg list":
			return "curl - 10-1 - Feed\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}
	m := newExecManagerWithRunner(t, runner)
	info, err := m.Info(context.Background(), "curl")
	if err != nil {
		t.Fatal(err)
	}

	if info.Status != "update_available" || info.Version != "10-1" || info.InstalledSize != "20" || info.InstalledTime != "123" {
		t.Fatalf("info = %+v", info)
	}
}
