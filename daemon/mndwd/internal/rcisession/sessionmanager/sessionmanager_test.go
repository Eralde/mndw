package sessionmanager

import (
	"errors"
	"net/http"
	"net/http/cookiejar"
	"testing"
	"time"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/heartbeat"
	"mndwd/internal/rcisession/proxy"
)

func TestManagerClassifiesEligibilityAndResolveStates(t *testing.T) {
	manager := New(Options{Now: func() time.Time { return time.Unix(100, 0) }})
	manager.ApplyEnumeration([]enumeration.Member{
		{Identity: "eligible", Name: "Eligible", IP: "192.0.2.1", FQDN: "Eligible.Keenetic.IO.", FQDNCertificateValid: true, AuthTokenCapable: true},
		{Identity: "unsupported", Name: "Unsupported", IP: "192.0.2.2", FQDN: "unsupported.keenetic.io", FQDNCertificateValid: false, AuthTokenCapable: true},
		{Identity: "offline", Name: "Offline", FQDN: "offline.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true},
	})

	if _, err := manager.Resolve("unsupported"); !errors.Is(err, proxy.ErrUnsupported) {
		t.Fatalf("unsupported Resolve() error = %v", err)
	}
	if _, err := manager.Resolve("eligible"); !errors.Is(err, proxy.ErrNoSession) {
		t.Fatalf("pending Resolve() error = %v", err)
	}
	if _, err := manager.Resolve("offline"); !errors.Is(err, proxy.ErrNoSession) {
		t.Fatalf("offline Resolve() error = %v", err)
	}

	snapshot := manager.Snapshot()
	if len(snapshot.Members) != 3 {
		t.Fatalf("snapshot members = %#v", snapshot.Members)
	}
	if snapshot.Member("unsupported").Reason != "certificate-invalid" {
		t.Fatalf("unsupported reason = %q", snapshot.Member("unsupported").Reason)
	}
	if snapshot.Member("unsupported").State != "" {
		t.Fatalf("ineligible state = %q, want omitted", snapshot.Member("unsupported").State)
	}
	if snapshot.Member("offline").State != StateOffline {
		t.Fatalf("offline state = %q", snapshot.Member("offline").State)
	}
	if snapshot.Member("eligible").State != StateEstablishing {
		t.Fatalf("eligible state = %q", snapshot.Member("eligible").State)
	}
}

func TestManagerEpochAndGenerationFenceStaleResults(t *testing.T) {
	manager := New()
	manager.ApplyEnumeration([]enumeration.Member{{Identity: "node", IP: "192.0.2.1", FQDN: "node.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true}})
	ctx, epoch, ok := manager.BeginEstablishment("node", manager.Epoch())
	if !ok {
		t.Fatal("BeginEstablishment() did not start")
	}
	manager.DiscardAll()
	select {
	case <-ctx.Done():
	default:
		t.Fatal("DiscardAll() did not cancel establishment")
	}
	if manager.CommitEstablishment("node", epoch, 1, Candidate{BaseURL: "https://node.keenetic.io", Jar: mustJar(t), Client: &http.Client{}}) {
		t.Fatal("stale establishment committed")
	}

	manager.ApplyEnumeration([]enumeration.Member{{Identity: "node", IP: "192.0.2.1", FQDN: "node.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true}})
	_, epoch, ok = manager.BeginEstablishment("node", manager.Epoch())
	if !ok {
		t.Fatal("second BeginEstablishment() did not start")
	}
	if !manager.CommitEstablishment("node", epoch, manager.Snapshot().Member("node").Generation, Candidate{BaseURL: "https://node.keenetic.io", Jar: mustJar(t), Client: &http.Client{}}) {
		t.Fatal("live establishment did not commit")
	}
	targets := manager.LiveHeartbeatTargets()
	if len(targets) != 1 {
		t.Fatalf("heartbeat targets = %#v", targets)
	}
	manager.Discard("node")
	manager.CommitHeartbeat("node", targets[0].Generation, heartbeat.Result{Status: http.StatusOK})
	if _, err := manager.Resolve("node"); !errors.Is(err, proxy.ErrNoSession) {
		t.Fatalf("stale heartbeat changed discarded session: %v", err)
	}
}

func mustJar(t *testing.T) http.CookieJar {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return jar
}
