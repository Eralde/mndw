package lookup

import (
	"encoding/json"
	"net"
	"testing"
)

func TestResolveEmptyHostname(t *testing.T) {
	result := Resolve("")

	if result.Success {
		t.Fatalf("expected failure for empty hostname")
	}
	if result.Error != "EMPTY_HOSTNAME" {
		t.Fatalf("expected error code EMPTY_HOSTNAME, got %s", result.Error)
	}
}

func TestResolveNXDOMAIN(t *testing.T) {
	orig := lookupHost
	lookupHost = func(host string) ([]string, error) {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	defer func() { lookupHost = orig }()

	result := Resolve("nope.invalid")

	if result.Success {
		t.Fatalf("expected failure for NXDOMAIN but got success with addresses: %v", result.Addresses)
	}
	if result.Error != "NXDOMAIN" {
		t.Fatalf("expected error code NXDOMAIN, got %s", result.Error)
	}
}

func TestResolveSuccess(t *testing.T) {
	origHost := lookupHost
	origCname := lookupCNAME
	lookupHost = func(host string) ([]string, error) {
		return []string{"10.0.0.1", "10.0.0.2"}, nil
	}
	lookupCNAME = func(host string) (string, error) {
		return host + ".", nil
	}
	defer func() {
		lookupHost = origHost
		lookupCNAME = origCname
	}()

	result := Resolve("example.local")

	if !result.Success {
		t.Fatalf("expected success but got error: %s", result.Message)
	}
	if result.Hostname != "example.local" {
		t.Fatalf("expected hostname example.local, got %s", result.Hostname)
	}
	if len(result.Addresses) != 2 {
		t.Fatalf("expected 2 addresses, got %d", len(result.Addresses))
	}
	if result.DurationMs <= 0 {
		t.Fatalf("expected positive duration, got %f", result.DurationMs)
	}
}

func TestResolveIPLiteralSkipsCNAMELookup(t *testing.T) {
	origHost := lookupHost
	origCname := lookupCNAME
	lookupHost = func(host string) ([]string, error) {
		return []string{host}, nil
	}
	lookupCNAME = func(host string) (string, error) {
		t.Fatalf("LookupCNAME called for IP literal %q", host)

		return "", nil
	}
	defer func() {
		lookupHost = origHost
		lookupCNAME = origCname
	}()

	result := Resolve("1.1.1.1")

	if !result.Success {
		t.Fatalf("expected IP lookup success but got error: %s", result.Message)
	}
	if result.Hostname != "1.1.1.1" {
		t.Fatalf("expected hostname 1.1.1.1, got %s", result.Hostname)
	}
	if result.Cname != "" {
		t.Fatalf("expected no CNAME for IP literal, got %q", result.Cname)
	}
}

func TestMarshalRoundtrip(t *testing.T) {
	result := LookupResult{
		Success:    true,
		Hostname:   "example.com",
		Addresses:  []string{"93.184.215.14"},
		DurationMs: 12.5,
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var parsed LookupResult
	if err = json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	if parsed.Hostname != result.Hostname || len(parsed.Addresses) != 1 || parsed.Addresses[0] != result.Addresses[0] {
		t.Fatalf("round-trip mismatch: %+v", parsed)
	}
}
