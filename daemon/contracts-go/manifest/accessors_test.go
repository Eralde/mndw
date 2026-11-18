package manifest

import "testing"

func TestManifestAccessorsHandleNilAndMissingFields(t *testing.T) {
	var nilManifest *Manifest

	if nilManifest.HasBackend() {
		t.Fatal("nil manifest has backend")
	}

	if kind, ok := nilManifest.BackendKind(); ok || kind != "" {
		t.Fatalf("nil manifest BackendKind() = (%q, %t), want (empty, false)", kind, ok)
	}

	if nilManifest.HasBackendKind() {
		t.Fatal("nil manifest reports a backend kind")
	}

	if nilManifest.IsService() || nilManifest.IsExec() {
		t.Fatal("nil manifest reports a backend kind")
	}

	stringGetters := []struct {
		name string
		get  func() string
	}{
		{name: "NameValue", get: nilManifest.NameValue},
		{name: "VersionValue", get: nilManifest.VersionValue},
		{name: "TypeValue", get: nilManifest.TypeValue},
		{name: "LabelValue", get: nilManifest.LabelValue},
		{name: "EntryValue", get: nilManifest.EntryValue},
		{name: "IconValue", get: nilManifest.IconValue},
		{name: "RouteValue", get: nilManifest.RouteValue},
	}

	for _, getter := range stringGetters {
		if got := getter.get(); got != "" {
			t.Errorf("nil manifest %s() = %q, want empty", getter.name, got)
		}
	}

	if got := nilManifest.VersionValueOr("unknown"); got != "unknown" {
		t.Errorf("nil manifest VersionValueOr() = %q, want unknown", got)
	}

	manifestWithoutBackend := &Manifest{}

	if manifestWithoutBackend.HasBackend() || manifestWithoutBackend.HasBackendKind() || manifestWithoutBackend.IsService() || manifestWithoutBackend.IsExec() {
		t.Fatal("manifest without backend reports backend capability")
	}

	if kind, ok := manifestWithoutBackend.BackendKind(); ok || kind != "" {
		t.Fatalf("manifest without backend BackendKind() = (%q, %t), want (empty, false)", kind, ok)
	}

	manifestWithoutKind := &Manifest{Backend: &Backend{}}

	if !manifestWithoutKind.HasBackend() {
		t.Fatal("manifest with backend reports no backend")
	}

	if kind, ok := manifestWithoutKind.BackendKind(); ok || kind != "" {
		t.Fatalf("manifest without kind BackendKind() = (%q, %t), want (empty, false)", kind, ok)
	}

	if manifestWithoutKind.HasBackendKind() {
		t.Fatal("manifest without kind reports a backend kind")
	}

	emptyKind := BackendKind("")
	manifestWithEmptyKind := &Manifest{Backend: &Backend{Kind: &emptyKind}}

	if !manifestWithEmptyKind.HasBackendKind() {
		t.Fatal("manifest with a present empty kind reports no backend kind")
	}
}

func TestManifestAccessorsReadValuesAndBackendKind(t *testing.T) {
	kind := BackendKindService
	name := "weather"
	version := "1.2.3"
	typeValue := "widget"
	label := "Weather"
	entry := "index.js"
	icon := "weather.svg"
	route := "/weather"

	m := &Manifest{
		Name:    &name,
		Version: &version,
		Type:    &typeValue,
		Label:   &label,
		Entry:   &entry,
		Icon:    &icon,
		Route:   &route,
		Backend: &Backend{Kind: &kind},
	}

	if !m.HasBackend() || !m.HasBackendKind() || !m.IsService() || m.IsExec() {
		t.Fatal("service manifest backend accessors returned incorrect values")
	}

	if got, ok := m.BackendKind(); !ok || got != BackendKindService {
		t.Fatalf("BackendKind() = (%q, %t), want (%q, true)", got, ok, BackendKindService)
	}

	if got := m.NameValue(); got != "weather" {
		t.Errorf("NameValue() = %q, want weather", got)
	}

	if got := m.VersionValue(); got != "1.2.3" {
		t.Errorf("VersionValue() = %q, want 1.2.3", got)
	}

	if got := m.VersionValueOr("unknown"); got != "1.2.3" {
		t.Errorf("VersionValueOr() = %q, want 1.2.3", got)
	}

	if got := m.TypeValue(); got != "widget" {
		t.Errorf("TypeValue() = %q, want widget", got)
	}

	if got := m.LabelValue(); got != "Weather" {
		t.Errorf("LabelValue() = %q, want Weather", got)
	}

	if got := m.EntryValue(); got != "index.js" {
		t.Errorf("EntryValue() = %q, want index.js", got)
	}

	if got := m.IconValue(); got != "weather.svg" {
		t.Errorf("IconValue() = %q, want weather.svg", got)
	}

	if got := m.RouteValue(); got != "/weather" {
		t.Errorf("RouteValue() = %q, want /weather", got)
	}
}

func TestVersionValueOrPreservesPresentEmptyValue(t *testing.T) {
	emptyVersion := ""
	m := &Manifest{Version: &emptyVersion}

	if got := m.VersionValueOr("unknown"); got != "" {
		t.Fatalf("VersionValueOr() = %q, want present empty value", got)
	}
}

func TestBackendAccessorsHandleNilAndKinds(t *testing.T) {
	var nilBackend *Backend

	if kind, ok := nilBackend.KindValue(); ok || kind != "" {
		t.Fatalf("nil backend KindValue() = (%q, %t), want (empty, false)", kind, ok)
	}

	if nilBackend.IsService() || nilBackend.IsExec() {
		t.Fatal("nil backend reports a kind")
	}

	execKind := BackendKindExec
	backend := &Backend{Kind: &execKind}

	if got, ok := backend.KindValue(); !ok || got != BackendKindExec {
		t.Fatalf("KindValue() = (%q, %t), want (%q, true)", got, ok, BackendKindExec)
	}

	if !backend.IsExec() || backend.IsService() {
		t.Fatal("exec backend accessors returned incorrect values")
	}
}
