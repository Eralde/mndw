package manifest

func (b *Backend) KindValue() (BackendKind, bool) {
	if b == nil || b.Kind == nil {
		return "", false
	}

	return *b.Kind, true
}

func (b *Backend) IsService() bool {
	kind, ok := b.KindValue()

	return ok && kind == BackendKindService
}

func (b *Backend) IsExec() bool {
	kind, ok := b.KindValue()

	return ok && kind == BackendKindExec
}

func (m *Manifest) HasBackend() bool {
	return m != nil && m.Backend != nil
}

func (m *Manifest) BackendKind() (BackendKind, bool) {
	if m == nil || m.Backend == nil {
		return "", false
	}

	return m.Backend.KindValue()
}

func (m *Manifest) HasBackendKind() bool {
	_, ok := m.BackendKind()

	return ok
}

func (m *Manifest) IsService() bool {
	return m != nil && m.Backend != nil && m.Backend.IsService()
}

func (m *Manifest) IsExec() bool {
	return m != nil && m.Backend != nil && m.Backend.IsExec()
}

func (m *Manifest) NameValue() string {
	if m == nil {
		return ""
	}

	return stringValue(m.Name)
}

func (m *Manifest) VersionValue() string {
	return m.VersionValueOr("")
}

func (m *Manifest) VersionValueOr(defaultValue string) string {
	if m == nil || m.Version == nil {
		return defaultValue
	}

	return *m.Version
}

func (m *Manifest) TypeValue() string {
	if m == nil {
		return ""
	}

	return stringValue(m.Type)
}

func (m *Manifest) LabelValue() string {
	if m == nil {
		return ""
	}

	return stringValue(m.Label)
}

func (m *Manifest) EntryValue() string {
	if m == nil {
		return ""
	}

	return stringValue(m.Entry)
}

func (m *Manifest) DescriptionValue() string {
	if m == nil {
		return ""
	}

	return stringValue(m.Description)
}

func (m *Manifest) RouteValue() string {
	if m == nil {
		return ""
	}

	return stringValue(m.Route)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}

	return *value
}
