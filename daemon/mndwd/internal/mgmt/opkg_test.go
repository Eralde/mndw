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

type failingListManager struct {
	opkg.Manager
}

func (m failingListManager) List(context.Context) ([]opkg.PackageEntry, error) {
	return nil, errors.New("list failed")
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
