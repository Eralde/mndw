// GENERATED from frontend/sdk/src/capabilities.ts — do not edit by hand.
package manifest

const (
	PersistentRCISessionReadCapability  = "persistent-rci-session:read"
	PersistentRCISessionWriteCapability = "persistent-rci-session:write"
)

// persistentRCICapabilities returns every grantable persistent RCI capability in
// authority order. It returns a fresh slice so callers cannot mutate the set.
func persistentRCICapabilities() []string {
	return []string{
		PersistentRCISessionReadCapability,
		PersistentRCISessionWriteCapability,
	}
}

const eventCapabilityPattern = `^events:(\*|[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*)$`
