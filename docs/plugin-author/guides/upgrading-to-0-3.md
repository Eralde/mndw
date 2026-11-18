# Upgrading to 0.3

Version 0.3 groups related `PluginContext` services and changes the plugin locale stream. Update context access in
plugin source, tests, and framework adapters before publishing. The [package versioning guide](/guides/project-setup#package-versioning)
explains how 0.x package ranges work.

## Migrate context access

| Before | After |
| --- | --- |
| `ctx.storage` | `ctx.storage.instance` |
| `ctx.sharedStorage` | `ctx.storage.shared` |
| `ctx.theme` / `ctx.theme$` | `ctx.appearance.theme` / `ctx.appearance.theme$` |
| `ctx.palette` / `ctx.palette$` | `ctx.appearance.palette` / `ctx.appearance.palette$` |
| `ctx.deviceInfo` | `ctx.device.info` |
| `ctx.rciManager` | `ctx.device.rci` |
| `ctx.createTicker()` | `ctx.timers.createTicker()` |
| `ctx.locale` | `ctx.i18n.locale` |
| `ctx.locale$` | `ctx.i18n.locale$` |
| `ctx.i18n.change$` | `ctx.i18n.locale$` |

The `kind`, `instanceId`, `signal`, `backend`, `events`, `telemetry`, `navigation`, `overlay`, and widget or page
members remain at their existing paths. `PluginContext` remains frozen and has a null prototype; its grouped objects
are frozen too.

In tests, keep your own `createTestI18n()` reference; `context.i18n` is the plugin-facing view.

## Migrate manifest permissions to capabilities

Rename `permissions` to `capabilities` in `manifest.json`. Capability values stay the same:

```json
{
  "permissions": ["events:wan", "persistent-rci-session:read"]
}
```

becomes:

```json
{
  "capabilities": ["events:wan", "persistent-rci-session:read"]
}
```

The old `permissions` field now fails validation with `permissions was renamed to capabilities in 0.3`.
Backend blocker objects use `BackendBlocker.capability` instead of `BackendBlocker.permission`. The SDK vocabulary
also changed: `PersistentRciPermission` → `PersistentRciCapability`, `PERSISTENT_RCI_PERMISSIONS` →
`PERSISTENT_RCI_CAPABILITIES`, `persistentRciPermissionSchema` → `persistentRciCapabilitySchema`,
`pluginPermissionSchema` → `pluginCapabilitySchema`, `isPersistentRciPermission` → `isPersistentRciCapability`,
`EVENT_PERMISSION_PATTERN` → `EVENT_CAPABILITY_PATTERN`, and `eventPermissionSchema` → `eventCapabilitySchema`.

Capabilities already granted on the router survive the upgrade. Settings → Plugins now shows them as
“Capabilities”.

## Update locale subscriptions

`i18n.locale$` emits the current locale when subscribed, then emits each new locale after its plugin catalog has been
applied. It completes when the plugin unmounts. Use it when rendering depends on both the active locale and translated
catalog:

```ts
const subscription = ctx.i18n.locale$.subscribe(() => {
  console.info(ctx.i18n.t('title'));
});
```

The initial emission handles the first render, so remove a separate initial render when it would duplicate that work.
The [frontend lifecycle guide](/guides/frontend-lifecycle) documents context stream timing and cleanup.

Further 0.3 migration notes can be added in their own sections as more APIs change.
