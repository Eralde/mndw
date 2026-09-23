// GENERATED from frontend/sdk/src/permissions.ts — do not edit by hand.
package manifest

const (
	PersistentRCISessionReadPermission  = "persistent-rci-session:read"
	PersistentRCISessionWritePermission = "persistent-rci-session:write"
)

// persistentRCIPermissions returns every grantable persistent RCI permission in
// authority order. It returns a fresh slice so callers cannot mutate the set.
func persistentRCIPermissions() []string {
	return []string{
		PersistentRCISessionReadPermission,
		PersistentRCISessionWritePermission,
	}
}

const eventPermissionPattern = `^events:(\*|[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*)$`
