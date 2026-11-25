package smartpage_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"smart-page/internal/devices"
	"smart-page/internal/httpapi"
	"smart-page/internal/model"
	"smart-page/internal/monitor"
)

type successfulScanExecutor struct {
	scans        chan string
	commands     chan model.Command
	manualResult model.CommandResult
}

func (executor *successfulScanExecutor) Run(_ context.Context, command model.Command) model.CommandResult {
	executor.commands <- command

	return executor.manualResult
}

func (executor *successfulScanExecutor) Scan(context.Context) model.CommandResult {
	executor.scans <- "plain"

	return model.CommandResult{Stdout: []byte(`{"devices":[{"name":"/dev/sda","type":"sat"}]}`), ExitCode: 0}
}

func (executor *successfulScanExecutor) ScanSCSI(context.Context) model.CommandResult {
	executor.scans <- "scsi"

	return model.CommandResult{Stdout: []byte(`{"devices":[]}`), ExitCode: 0}
}

type integrationOS struct{}

func (integrationOS) Inspect(path string) (devices.Binding, error) {
	if path == "/dev/sda" {
		return devices.Binding{Path: path, Token: "disk-token"}, nil
	}

	return devices.Binding{}, errors.New("not found")
}

func TestScansAndRefreshCompleteThroughRegistry(t *testing.T) {
	manualOutput, err := os.ReadFile(filepath.Join("testdata", "ata-hdd.json"))
	if err != nil {
		t.Fatalf("read manual SMART fixture: %v", err)
	}

	executor := &successfulScanExecutor{
		scans:        make(chan string, 2),
		commands:     make(chan model.Command, 1),
		manualResult: model.CommandResult{Stdout: manualOutput, ExitCode: 0},
	}
	registry := devices.NewRegistry(integrationOS{}, func() string { return "disk-1" })
	controller := monitor.New(monitor.Dependencies{Executor: executor, Registry: registry})
	serviceContext, cancelService := context.WithCancel(context.Background())

	defer cancelService()

	go controller.Run(serviceContext)

	handler := httpapi.New(controller, "smart-page", 1)

	acceptedResponse := httptest.NewRecorder()
	acceptedRequest := httptest.NewRequest(http.MethodPost, "/discover", jsonBody(`{"acknowledgeWake":true}`))

	handler.ServeHTTP(acceptedResponse, acceptedRequest)

	if acceptedResponse.Code != http.StatusAccepted {
		t.Fatalf("discover status = %d, want %d: %s", acceptedResponse.Code, http.StatusAccepted, acceptedResponse.Body.String())
	}

	var accepted model.AcceptedOperation

	if err := json.Unmarshal(acceptedResponse.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("decode accepted operation: %v", err)
	}

	for _, want := range []string{"plain", "scsi"} {
		select {
		case got := <-executor.scans:
			if got != want {
				t.Fatalf("scan order = %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s scan did not start", want)
		}
	}

	deadline := time.NewTimer(time.Second)

	defer deadline.Stop()

	for {
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/operation?id="+string(accepted.OperationID), nil))

		if response.Code != http.StatusOK {
			t.Fatalf("operation status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
		}

		var operation model.Operation

		if err := json.Unmarshal(response.Body.Bytes(), &operation); err != nil {
			t.Fatalf("decode operation: %v", err)
		}

		if operation.Status == model.OperationSucceeded {
			result, ok := operation.Result.(model.DiscoverResult)

			if !ok || result.ExitCode != 0 || result.Truncated || len(result.DeviceIDs) != 1 || result.DeviceIDs[0] != "disk-1" || operation.Error != nil || operation.CompletedAt == nil {
				t.Fatalf("successful scan operation = %+v, want succeeded discover result for disk-1", operation)
			}

			break
		}

		if operation.Status != model.OperationQueued && operation.Status != model.OperationRunning {
			t.Fatalf("successful scan operation = %+v, want pending then succeeded", operation)
		}

		select {
		case <-deadline.C:
			t.Fatalf("operation did not succeed after scans: %+v", operation)
		default:
			runtime.Gosched()
		}
	}

	snapshotResponse := httptest.NewRecorder()

	handler.ServeHTTP(snapshotResponse, httptest.NewRequest(http.MethodGet, "/snapshot", nil))

	var snapshot model.Snapshot

	if err := json.Unmarshal(snapshotResponse.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}

	if len(snapshot.Devices) != 1 || snapshot.Devices[0].DeviceID != "disk-1" {
		t.Fatalf("snapshot devices = %+v, want registry device disk-1", snapshot.Devices)
	}

	if hasReason(snapshot.Diagnostics.Reasons, "discovery-not-run") {
		t.Fatalf("snapshot diagnostics = %+v, must clear discovery-not-run after successful discover", snapshot.Diagnostics.Reasons)
	}

	unknownResponse := httptest.NewRecorder()

	handler.ServeHTTP(unknownResponse, httptest.NewRequest(http.MethodPost, "/refresh", jsonBody(`{"deviceId":"missing","acknowledgeWake":true}`)))

	if unknownResponse.Code != http.StatusNotFound {
		t.Fatalf("unknown refresh status = %d, want %d: %s", unknownResponse.Code, http.StatusNotFound, unknownResponse.Body.String())
	}

	refreshResponse := httptest.NewRecorder()

	handler.ServeHTTP(refreshResponse, httptest.NewRequest(http.MethodPost, "/refresh", jsonBody(`{"deviceId":"disk-1","acknowledgeWake":true}`)))

	if refreshResponse.Code != http.StatusAccepted {
		t.Fatalf("refresh status = %d, want %d: %s", refreshResponse.Code, http.StatusAccepted, refreshResponse.Body.String())
	}

	var refreshAccepted model.AcceptedOperation

	if err := json.Unmarshal(refreshResponse.Body.Bytes(), &refreshAccepted); err != nil {
		t.Fatalf("decode accepted refresh: %v", err)
	}

	select {
	case command := <-executor.commands:
		if command.Mode != "manual" || command.Target.Path != "/dev/sda" || command.Target.Type != "sat" || command.Target.BindingToken != "disk-token" {
			t.Fatalf("manual command = %+v, want registry target", command)
		}
	case <-time.After(time.Second):
		t.Fatal("manual refresh did not reach executor")
	}

	refreshDeadline := time.NewTimer(time.Second)

	defer refreshDeadline.Stop()

	for {
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/operation?id="+string(refreshAccepted.OperationID), nil))

		var operation model.Operation

		if err := json.Unmarshal(response.Body.Bytes(), &operation); err != nil {
			t.Fatalf("decode refresh operation: %v", err)
		}

		if operation.Status == model.OperationSucceeded {
			result, ok := operation.Result.(model.RefreshResult)

			if !ok || result.DeviceID != "disk-1" || result.ExitCode != 0 || !result.SampleAccepted || operation.Error != nil {
				t.Fatalf("successful refresh operation = %+v, want sampleAccepted=true", operation)
			}

			break
		}

		if operation.Status != model.OperationQueued && operation.Status != model.OperationRunning {
			t.Fatalf("refresh operation = %+v, want pending then succeeded", operation)
		}

		select {
		case <-refreshDeadline.C:
			t.Fatalf("refresh operation did not succeed: %+v", operation)
		default:
			runtime.Gosched()
		}
	}

	refreshSnapshotResponse := httptest.NewRecorder()

	handler.ServeHTTP(refreshSnapshotResponse, httptest.NewRequest(http.MethodGet, "/snapshot", nil))

	var refreshSnapshot model.Snapshot

	if err := json.Unmarshal(refreshSnapshotResponse.Body.Bytes(), &refreshSnapshot); err != nil {
		t.Fatalf("decode refreshed snapshot: %v", err)
	}

	if len(refreshSnapshot.Devices) != 1 || refreshSnapshot.Devices[0].DeviceID != "disk-1" || refreshSnapshot.Devices[0].Sample == nil {
		t.Fatalf("refreshed snapshot devices = %+v, want accepted sample for disk-1", refreshSnapshot.Devices)
	}

	cancelService()

	if err := controller.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

const testSchedulingTolerance = time.Second
const testHelperExitTimeout = 12 * time.Second
const testShutdownSetupTimeout = 3 * time.Second
const testShutdownRequestTimeout = 500 * time.Millisecond
const testShutdownPollInterval = 10 * time.Millisecond

func TestShutdownBudget(t *testing.T) {
	helperBinary := filepath.Join(t.TempDir(), "smart-page-shutdown.test")
	build := exec.Command("go", "test", "-c", "-o", helperBinary, "./cmd/smart-page")
	build.Env = append(os.Environ(), "GOWORK=off", "GOPROXY=off")

	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build shutdown helper binary: %v\n%s", err, output)
	}

	tests := []struct {
		name         string
		signal       syscall.Signal
		handlerMode  string
		wantDeadline bool
	}{
		{name: "SIGTERM normal drain", signal: syscall.SIGTERM, handlerMode: "release-on-signal"},
		{name: "SIGINT shared deadline", signal: syscall.SIGINT, handlerMode: "hold", wantDeadline: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			socketDirectory, err := os.MkdirTemp("/tmp", "st7-")
			if err != nil {
				t.Fatalf("create short socket directory: %v", err)
			}

			socketPath := filepath.Join(socketDirectory, "s.sock")
			childStartedPath := filepath.Join(directory, "child.started")
			childReapedPath := filepath.Join(directory, "child.reaped")
			handlerStartedPath := filepath.Join(directory, "handler.started")
			runErrorPath := filepath.Join(directory, "run.error")
			helper, err := startShutdownHelper(helperBinary, []string{
				"SMART_PAGE_SHUTDOWN_HELPER=1",
				"SMART_PAGE_SHUTDOWN_SOCKET=" + socketPath,
				"SMART_PAGE_SHUTDOWN_MODE=" + test.handlerMode,
				"SMART_PAGE_SHUTDOWN_CHILD_STARTED=" + childStartedPath,
				"SMART_PAGE_SHUTDOWN_CHILD_REAPED=" + childReapedPath,
				"SMART_PAGE_SHUTDOWN_HANDLER_STARTED=" + handlerStartedPath,
				"SMART_PAGE_SHUTDOWN_RUN_ERROR=" + runErrorPath,
			})
			if err != nil {
				t.Fatalf("start shutdown helper: %v", err)
			}

			client := shutdownHTTPClient(socketPath)
			var blockedCancel context.CancelFunc
			var blockedDone <-chan struct{}

			t.Cleanup(func() {
				if blockedCancel != nil {
					blockedCancel()
					<-blockedDone
				}

				helper.killAndWait()
				client.CloseIdleConnections()

				_ = os.RemoveAll(socketDirectory)
			})

			waitForShutdown(t, helper, "HTTP readiness", func() bool {
				return shutdownHTTPReady(client)
			})
			postShutdownRequest(t, client, "/start")
			waitForShutdown(t, helper, "fake child start", func() bool {
				return shutdownFileExists(childStartedPath)
			})

			blockedCancel, blockedDone = startBlockedShutdownRequest(t, client)

			waitForShutdown(t, helper, "blocked handler start", func() bool {
				return shutdownFileExists(handlerStartedPath)
			})

			startedAt := time.Now()

			if err := helper.command.Process.Signal(test.signal); err != nil {
				t.Fatalf("send %s to helper: %v", test.signal, err)
			}

			helperErr, exited := helper.wait(testHelperExitTimeout)

			if !exited {
				t.Fatalf("helper did not exit within %s: %s", testHelperExitTimeout, helper.output.String())
			}

			elapsed := time.Since(startedAt)

			if elapsed > 5*time.Second+testSchedulingTolerance {
				t.Fatalf("helper exited after %s, want within 5s + %s", elapsed, testSchedulingTolerance)
			}

			if helperErr != nil {
				t.Fatalf("shutdown helper exited with %v: %s", helperErr, helper.output.String())
			}

			if _, err := os.Stat(childReapedPath); err != nil {
				t.Fatalf("child was not reaped: %v", err)
			}

			if test.wantDeadline {
				runError, err := os.ReadFile(runErrorPath)
				if err != nil {
					t.Fatalf("read run error: %v", err)
				}

				if !strings.Contains(string(runError), "cleanup is not guaranteed") {
					t.Fatalf("run error = %q, want cleanup warning", runError)
				}
			} else if _, err := os.Stat(runErrorPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("normal shutdown run error stat = %v, want no error file", err)
			}

			if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("socket stat after shutdown = %v, want removed", err)
			}
		})
	}
}

type shutdownHelper struct {
	command *exec.Cmd
	done    chan struct{}
	waitErr error
	output  synchronizedBuffer
}

func startShutdownHelper(helperBinary string, environment []string) (*shutdownHelper, error) {
	command := exec.Command(helperBinary, "-test.run=^TestShutdownHelperProcess$")
	command.Env = append(os.Environ(), environment...)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	helper := &shutdownHelper{command: command, done: make(chan struct{})}
	command.Stdout = &helper.output
	command.Stderr = &helper.output

	if err := command.Start(); err != nil {
		return nil, err
	}

	go func() {
		helper.waitErr = command.Wait()

		close(helper.done)
	}()

	return helper, nil
}

func (helper *shutdownHelper) wait(timeout time.Duration) (error, bool) {
	timer := time.NewTimer(timeout)

	defer timer.Stop()

	select {
	case <-helper.done:
		return helper.waitErr, true
	case <-timer.C:
		return nil, false
	}
}

func (helper *shutdownHelper) killAndWait() {
	select {
	case <-helper.done:
		return
	default:
		_ = syscall.Kill(-helper.command.Process.Pid, syscall.SIGKILL)

		<-helper.done
	}
}

type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *synchronizedBuffer) Write(contents []byte) (int, error) {
	buffer.mu.Lock()

	defer buffer.mu.Unlock()

	return buffer.buffer.Write(contents)
}

func (buffer *synchronizedBuffer) String() string {
	buffer.mu.Lock()

	defer buffer.mu.Unlock()

	return buffer.buffer.String()
}

func shutdownHTTPClient(socketPath string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
			},
		},
	}
}

func shutdownHTTPReady(client *http.Client) bool {
	ctx, cancel := context.WithTimeout(context.Background(), testShutdownRequestTimeout)

	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/ready", nil)
	if err != nil {
		return false
	}

	response, err := client.Do(request)
	if err != nil {
		return false
	}

	defer response.Body.Close()

	return response.StatusCode == http.StatusNoContent
}

func startBlockedShutdownRequest(t *testing.T, client *http.Client) (context.CancelFunc, <-chan struct{}) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://unix/block", nil)
	if err != nil {
		cancel()
		t.Fatalf("build blocked handler request: %v", err)
	}

	done := make(chan struct{})

	go func() {
		defer close(done)

		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
		}
	}()

	return cancel, done
}

func waitForShutdown(t *testing.T, helper *shutdownHelper, description string, ready func() bool) {
	t.Helper()

	deadline := time.NewTimer(testShutdownSetupTimeout)
	ticker := time.NewTicker(testShutdownPollInterval)

	defer deadline.Stop()

	defer ticker.Stop()

	for {
		if ready() {
			return
		}

		select {
		case <-helper.done:
			t.Fatalf("shutdown helper exited before %s (%v): %s", description, helper.waitErr, helper.output.String())
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s: %s", description, helper.output.String())
		case <-ticker.C:
		}
	}
}

func shutdownFileExists(path string) bool {
	_, err := os.Stat(path)

	return err == nil
}

func postShutdownRequest(t *testing.T, client *http.Client, path string) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), testShutdownRequestTimeout)

	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://unix"+path, nil)
	if err != nil {
		t.Fatalf("build %s request: %v", path, err)
	}

	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("send %s request: %v", path, err)
	}

	_ = response.Body.Close()

	if response.StatusCode != http.StatusAccepted && response.StatusCode != http.StatusNoContent {
		t.Fatalf("%s status = %d, want accepted or no-content", path, response.StatusCode)
	}
}

func hasReason(reasons []model.Text, expected string) bool {
	for _, reason := range reasons {
		if string(reason) == expected {
			return true
		}
	}

	return false
}

func jsonBody(value string) *strings.Reader {
	return strings.NewReader(value)
}
