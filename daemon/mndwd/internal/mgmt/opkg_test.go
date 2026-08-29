package mgmt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"mndwd/internal/opkg"
)

func TestOpkgList(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/mgmt/opkg/list")
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var body struct {
		Packages []opkg.PackageEntry `json:"packages"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}

	if len(body.Packages) != 6 {
		t.Fatalf("len(packages) = %d, want 6", len(body.Packages))
	}

	if body.Packages[0].Name != "bash" || body.Packages[0].Status != "installed" {
		t.Errorf("bash entry = %+v", body.Packages[0])
	}

	if body.Packages[3].Name != "jq" || body.Packages[3].Status != "update_available" || body.Packages[3].Version != "1.6-2" || body.Packages[3].NewVersion != "1.7-1" {
		t.Errorf("jq entry = %+v", body.Packages[3])
	}
}

func TestOpkgContextDerivesFromServiceActionRoot(t *testing.T) {
	root, cancelRoot := context.WithCancel(context.Background())
	h := New(Config{ServiceActionRoot: root}, nil, nil, nil, nil, discardLogger())

	ctx, cancel := h.opkgContext()

	defer cancel()

	cancelRoot()

	select {
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatalf("opkg context error = %v, want context canceled", ctx.Err())
		}
	default:
		t.Fatal("opkg context survived daemon lifetime cancellation")
	}
}

type failingListManager struct {
	opkg.Manager
}

func (m failingListManager) List(context.Context) (opkg.PackageList, error) {
	return opkg.PackageList{}, errors.New("list failed")
}

func TestOpkgListOpkgFailure(t *testing.T) {
	base := opkg.New("stub", discardLogger())
	srv, _ := newTestServerWithOpkg(t, failingListManager{Manager: base})
	resp, err := http.Get(srv.URL + "/api/mgmt/opkg/list")
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}

	assertCode(t, resp, "OPKG_FAILED")
}

func TestOpkgInstallInvalidName(t *testing.T) {
	srv, _ := newTestServer(t)
	body, _ := json.Marshal(map[string][]string{"packages": {"BAD NAME"}})
	resp, err := http.Post(srv.URL+"/api/mgmt/opkg/install", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}

	assertCode(t, resp, "INVALID_PACKAGE_NAME")
}

func TestOpkgInstallEmpty(t *testing.T) {
	srv, _ := newTestServer(t)
	body, _ := json.Marshal(map[string][]string{"packages": {}})
	resp, err := http.Post(srv.URL+"/api/mgmt/opkg/install", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

type dependencyConflictManager struct {
	opkg.Manager
}

func (m dependencyConflictManager) Remove(context.Context, []string) error {
	return &opkg.DependencyConflictError{Package: "curl", DependedBy: []string{"wget-ssl"}}
}

func TestOpkgRemoveDependencyConflict(t *testing.T) {
	base := opkg.New("stub", discardLogger())
	srv, _ := newTestServerWithOpkg(t, dependencyConflictManager{Manager: base})
	body, _ := json.Marshal(map[string][]string{"packages": {"curl"}})
	resp, err := http.Post(srv.URL+"/api/mgmt/opkg/remove", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}

	assertCode(t, resp, "DEPENDENCY_CONFLICT")
}

func TestOpkgActionMessages(t *testing.T) {
	srv, _ := newTestServer(t)
	tests := []struct {
		path    string
		body    map[string][]string
		message string
	}{
		{path: "/api/mgmt/opkg/install", body: map[string][]string{"packages": {"curl", "ttyd"}}, message: "2 package(s) installed"},
		{path: "/api/mgmt/opkg/remove", body: map[string][]string{"packages": {"curl"}}, message: "1 package(s) removed"},
		{path: "/api/mgmt/opkg/upgrade", body: map[string][]string{"packages": {"jq"}}, message: "1 package(s) upgraded"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			payload, err := json.Marshal(tt.body)
			if err != nil {
				t.Fatal(err)
			}

			resp, err := http.Post(srv.URL+tt.path, "application/json", bytes.NewReader(payload))
			if err != nil {
				t.Fatal(err)
			}

			defer resp.Body.Close()

			var body struct {
				Message string `json:"message"`
			}

			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}

			if body.Message != tt.message {
				t.Errorf("message = %q, want %q", body.Message, tt.message)
			}
		})
	}

	resp, err := http.Post(srv.URL+"/api/mgmt/opkg/update", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	var body struct {
		Message string `json:"message"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}

	if body.Message != "Package metadata refreshed" {
		t.Errorf("update message = %q", body.Message)
	}
}
