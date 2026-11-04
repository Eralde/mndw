package mgmt

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/state"
)

func TestReadPluginLockValid(t *testing.T) {
	dir := t.TempDir()
	raw := `{"lockVersion":1,"sdkVersion":"1.2.3","sharedDependencies":{"rxjs":"7.8.2"}}`

	if err := os.WriteFile(filepath.Join(dir, "mndw.lock.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	got := readPluginLock(dir)

	if got == nil {
		t.Fatal("readPluginLock() = nil, want parsed lock")
	}

	if got.SDKVersion != "1.2.3" || got.SharedDependencies["rxjs"] != "7.8.2" {
		t.Fatalf("readPluginLock() = %+v, want SDK 1.2.3 and rxjs 7.8.2", got)
	}
}

func TestReadPluginLockRejects(t *testing.T) {
	large := `{"lockVersion":1,"sdkVersion":"1.2.3","sharedDependencies":{}}` + strings.Repeat(" ", 64*1024)

	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "missing file"},
		{name: "invalid JSON", body: `{`},
		{name: "unsupported lock version", body: `{"lockVersion":2,"sdkVersion":"1.2.3","sharedDependencies":{}}`},
		{name: "missing SDK version", body: `{"lockVersion":1,"sharedDependencies":{}}`},
		{name: "non-string SDK version", body: `{"lockVersion":1,"sdkVersion":2,"sharedDependencies":{}}`},
		{name: "missing shared dependencies", body: `{"lockVersion":1,"sdkVersion":"1.2.3"}`},
		{name: "non-string shared dependency", body: `{"lockVersion":1,"sdkVersion":"1.2.3","sharedDependencies":{"rxjs":2}}`},
		{name: "oversized file", body: large},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()

			if tc.body != "" {
				if err := os.WriteFile(filepath.Join(dir, "mndw.lock.json"), []byte(tc.body), 0o644); err != nil {
					t.Fatal(err)
				}
			}

			if got := readPluginLock(dir); got != nil {
				t.Fatalf("readPluginLock() = %+v, want nil", got)
			}
		})
	}
}

func TestListEntryCarriesLock(t *testing.T) {
	srv, cfg := newTestServer(t)
	lockJSON := `{"lockVersion":1,"sdkVersion":"2.0.0","sharedDependencies":{"rxjs":"8.0.0"}}`
	withLockManifest := strings.Replace(backendManifest, `"name": "svc"`, `"name": "locked-service"`, 1)
	withoutLockManifest := strings.Replace(backendManifest, `"name": "svc"`, `"name": "plain-service"`, 1)

	for _, plugin := range []struct {
		name     string
		manifest string
		withLock bool
	}{
		{name: "locked-service", manifest: withLockManifest, withLock: true},
		{name: "plain-service", manifest: withoutLockManifest},
	} {
		files := map[string]string{
			"manifest.json":  plugin.manifest,
			"index.js":       "export function createInstance(){}",
			"backend/run.sh": "#!/bin/sh\necho hi\n",
		}

		if plugin.withLock {
			files["mndw.lock.json"] = lockJSON
		}

		resp := upload(t, srv, makeZip(t, files))

		resp.Body.Close()

		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("upload %s status = %d, want 202", plugin.name, resp.StatusCode)
		}
	}

	pending := listPlugins(t, srv, "/api/mgmt/pending")
	locked, ok := findEntry(pending, "locked-service")

	if !ok {
		t.Fatal("locked pending plugin missing from list")
	}

	if locked.Lock == nil || locked.Lock.SDKVersion != "2.0.0" {
		t.Fatalf("pending lock = %+v, want SDK 2.0.0", locked.Lock)
	}

	plain, ok := findEntry(pending, "plain-service")

	if !ok {
		t.Fatal("plugin without lock missing from list")
	}

	if plain.Lock != nil {
		t.Fatalf("plugin without lock has lock %+v", plain.Lock)
	}

	lockedJSON, err := json.Marshal(locked)
	if err != nil {
		t.Fatal(err)
	}

	plainJSON, err := json.Marshal(plain)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(lockedJSON), `"lock":`) || strings.Contains(string(plainJSON), `"lock"`) {
		t.Fatalf("lock JSON presence mismatch: locked=%s plain=%s", lockedJSON, plainJSON)
	}

	approve := postName(t, srv, "/api/mgmt/approve", "locked-service")

	approve.Body.Close()

	if approve.StatusCode != http.StatusOK {
		t.Fatalf("approve status = %d, want 200", approve.StatusCode)
	}

	installed, ok := findEntry(listPlugins(t, srv, "/api/mgmt/list"), "locked-service")

	if !ok || installed.Approval != state.ApprovalApproved {
		t.Fatalf("approved plugin entry = %+v, present=%v", installed, ok)
	}

	if installed.Lock == nil || installed.Lock.SDKVersion != "2.0.0" {
		t.Fatalf("installed lock = %+v, want SDK 2.0.0", installed.Lock)
	}

	if _, err := os.Stat(filepath.Join(cfg.UserPluginsDir, "locked-service", "mndw.lock.json")); err != nil {
		t.Fatalf("approved lock not moved to user plugins: %v", err)
	}
}
