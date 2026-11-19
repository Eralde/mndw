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

## RCI one-shot calls

Use `await ctx.device.rci.query({path: 'show.version'})` for a one-shot request. It returns a Promise and accepts an
optional `{signal}` option. Import `RciQuery`, `RciBackgroundProcess`, and `RciResponseHelper` from `@mndw/sdk`.

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

## Timers

Remove the `createRefreshLoop` import from `@mndw/sdk/refresh` and create loops through the plugin context:

```ts
import type {
  PluginContext as RefreshExamplePluginContext,
  ProjectRange as RefreshExampleRange,
  ProjectedSnapshot as RefreshExampleSnapshot,
} from '@mndw/sdk';

declare const refreshExampleContext: RefreshExamplePluginContext;
declare const refreshExampleRange: RefreshExampleRange;
declare function renderRefreshExample(snapshot: RefreshExampleSnapshot): void;
declare function showRefreshExampleError(error: unknown, isInitial: boolean): void;

const refreshLoop = refreshExampleContext.timers.createRefreshLoop({
  load: (signal) => refreshExampleContext.telemetry.fetchProjected(refreshExampleRange, {signal}),
  intervalMs: 10_000,
  onSuccess: (snapshot) => renderRefreshExample(snapshot),
  onError: (error, isInitial) => showRefreshExampleError(error, isInitial),
});

refreshLoop.start();
```

Pass the supplied `AbortSignal` to APIs that accept one. The loop prevents overlapping loads, ignores late results,
and aborts the active load when stopped. All loops stop when their plugin context ends, so remove teardown calls that
only stopped a loop during plugin unmount. Keep `stop()` for user actions that pause or replace a loop, and use
`setIntervalMs()` when its cadence changes.

## Backend client is always present

`ctx.backend` always exists, even when `manifest.json` has no `backend` field. In that case it is a no-network stub:
`fetch()`, `call()`, and `status()` reject with `BackendError` code `BACKEND_NOT_DECLARED`; its message points to the
manifest `backend` field. `socket()` throws that same error synchronously. A plugin that needs backend functionality
still needs to declare its routes in the manifest.

Backend author errors from `fetch()`, `call()`, and `status()` are Promise rejections. This includes unknown route IDs,
wrong transport, and a missing backend declaration. Put the `await` inside `try` so the rejection is caught:

```ts
import {BackendError, type PluginContext} from '@mndw/sdk';

async function load(ctx: PluginContext): Promise<void> {
  try {
    const result = await ctx.backend.call<{message: string}>('hello', {as: 'json', signal: ctx.signal});
    console.info(result.message);
  } catch (error: unknown) {
    if (error instanceof BackendError) {
      console.error(error.code, error.message);
      return;
    }

    throw error;
  }
}
```

If older code relied on a synchronous throw from calling `call()` before awaiting it, move the call into the awaited
`try` block. A `try` around only the method invocation no longer catches these errors:

```ts
// Old: does not catch a rejected Promise.
try {
  const request = ctx.backend.call('hello');
  void request;
} catch (error) {
  console.error(error);
}

// New: catches the Promise rejection.
try {
  await ctx.backend.call('hello');
} catch (error) {
  console.error(error);
}
```

## WebSocket routes

`socket()` remains synchronous for author errors: unknown IDs, wrong transport, and no backend declaration throw at the
call site. For a known route blocked by plugin state, it returns an already-closed WebSocket-like object. The close event
is delivered asynchronously and exposes its code and readable reason through `onclose` or
`addEventListener('close', ...)`. Codes are exported as `BackendSocketCloseCode` from `@mndw/sdk`:

| Constant | Code | Meaning |
| --- | ---: | --- |
| `BackendSocketCloseCode.notApproved` | `4001` | Plugin backend needs approval |
| `BackendSocketCloseCode.disabled` | `4002` | Plugin backend is disabled |

```ts
import {BackendSocketCloseCode} from '@mndw/sdk';

const socket = ctx.backend.socket('stream');
socket.addEventListener('close', (event) => {
  if (event.code === BackendSocketCloseCode.notApproved) {
    console.info(`Approve plugin backend: ${event.reason}`);
  }
});
```

The blocked socket reports `readyState === WebSocket.CLOSED`. Calling `close()` is safe and has no network side effect.

## Events facade is always present

`ctx.events` always exists. `select$()` errors for a specific topic when the manifest has no event capability or the
topic is outside the plugin's grants. Add a matching `events:<namespace>` capability to the manifest. For example,
topics beginning with `usb.` need `events:usb`; the error names that capability. A wildcard request such as
`select$('*')` silently narrows to the topics the manifest grants; with no grants it completes without events.
`resync$` completes immediately when no event capability is granted.

```ts
ctx.events.select$('usb.device_added').subscribe({
  next: (event) => console.info(event.topic),
  error: (error: unknown) => console.error(error),
});
```

## Widget title setter

Widget contexts now always provide `ctx.setTileTitle(title)`. Page contexts do not have that property. Narrow a generic
`PluginContext` by `kind` before setting a tile title:

```ts
if (ctx.kind === 'widget') {
  ctx.setTileTitle(ctx.i18n.t('title'));
}
```

The SDK test fixture follows the same rule. Its widget context has a default title recorder; read recorded values from
`fixture.tileTitles`. Page fixtures omit the setter.

## Manifest

The manifest has a new optional `description`: plain text of 1–160 characters in the plugin's default language.
The host shows it in the Add widget dialog.

```json
{
  "label": "Ping",
  "description": "Track ping statistics for hosts you choose."
}
```

To translate the name and the description, add the reserved keys `manifest.label` and `manifest.description` to
each catalog in `i18n/`. The host loads the catalog of every enabled plugin at startup, so the sidebar, settings
and the Add widget dialog show translated names before the plugin mounts. Until a catalog loads, or when a key is
missing, the host uses the manifest values.

The `icon` field is removed. Delete it from `manifest.json`; an old manifest fails validation with
`icon was removed in 0.3`.

The `fixedHeight` field is removed. Delete it from `manifest.json`; an old manifest fails validation with
`fixedHeight was removed in 0.3`.
