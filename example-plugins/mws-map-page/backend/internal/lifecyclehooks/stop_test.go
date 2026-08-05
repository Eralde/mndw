package lifecyclehooks

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestStopHookWaitsForProcess(t *testing.T) {
	runtimeDir := t.TempDir()
	helperPidPath := filepath.Join(runtimeDir, "helper.pid")
	helper := exec.Command(os.Args[0], "-test.run=TestHookHelper", "--")
	helper.Env = append(os.Environ(), "MNDW_HOOK_HELPER=1", "MNDW_HOOK_PID_PATH="+helperPidPath)
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer helper.Wait()

	var helperPID int
	deadline := time.Now().Add(5 * time.Second)
	for helperPID == 0 && time.Now().Before(deadline) {
		data, err := os.ReadFile(helperPidPath)
		if err == nil {
			helperPID, err = strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if helperPID == 0 {
		t.Fatal("helper PID was not published")
	}
	waited := false
	defer func() {
		if !waited {
			_ = syscall.Kill(helperPID, syscall.SIGKILL)
		}
	}()

	pidPath := filepath.Join(runtimeDir, "mwsd.pid")
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(helperPID)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(runtimeDir, "mwsd.sock")
	if err := os.WriteFile(socketPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	command := exec.Command("sh", "../../stop.sh")
	command.Env = append(os.Environ(), "MNDW_PLUGIN_RUNTIME_DIR="+runtimeDir)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("stop.sh failed: %v\n%s", err, output)
	}
	if elapsed := time.Since(started); elapsed < 500*time.Millisecond {
		t.Fatalf("stop.sh returned after %s, want at least 500ms", elapsed)
	}
	for syscall.Kill(helperPID, 0) == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	waited = true
	if syscall.Kill(helperPID, 0) == nil {
		t.Fatal("helper process remains after stop.sh")
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatalf("mwsd.pid stat error = %v, want not exist", err)
	}
	if _, err := os.Stat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("mwsd.sock stat error = %v, want not exist", err)
	}
}

func TestHookHelper(t *testing.T) {
	if os.Getenv("MNDW_HOOK_HELPER") != "1" {
		return
	}
	if os.Getenv("MNDW_HOOK_CHILD") != "1" {
		child := exec.Command(os.Args[0], "-test.run=TestHookHelper", "--")
		child.Env = append(os.Environ(), "MNDW_HOOK_HELPER=1", "MNDW_HOOK_CHILD=1")
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("MNDW_HOOK_PID_PATH"), []byte(strconv.Itoa(child.Process.Pid)+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	defer signal.Stop(signals)
	<-signals
	time.Sleep(700 * time.Millisecond)
	os.Exit(0)
}
