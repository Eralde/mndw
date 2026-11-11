# Upgrading to 0.2

Version 0.2 is a coordinated breaking release for plugins. Update package ranges and replace removed context APIs
before publishing. The [package versioning guide](/guides/project-setup#package-versioning) explains why 0.x caret
ranges do not cross minor versions.

## Update package ranges

Change both SDK and UI packages to `^0.2.0`:

```json
{
  "dependencies": {
    "@mndw/sdk": "^0.1.6",
    "@mndw/ui": "^0.1.6"
  }
}
```

```json
{
  "dependencies": {
    "@mndw/sdk": "^0.2.0",
    "@mndw/ui": "^0.2.0"
  }
}
```

An installed plugin built for SDK 0.1 shows a warning badge in **Settings → Plugins** when the host provides SDK 0.2.
A warning below the badge identifies both SDK versions. The plugin can still load, but may not work correctly.

Plugins with asynchronous setup can use new optional `ctx.signal` API to cancel requests or initialization when host disposes the context; plugins with no author-owned async work need no change.

## Keep backend commands under `backend/`

Set `backend.command` and every `backend.routes[].command` to a safe relative path beginning with `backend/`, such
as `backend/run.sh`. The daemon does not serve files from `backend/` as browser assets, and user-plugin assets now
require an authenticated device session.

## Read backend error codes from `code`

`BackendError.daemonCode` was removed. Check the error's `code` instead:

<!-- docs-check: skip -->
```ts
if (err instanceof BackendError && err.daemonCode === 'DISABLED') {
  showDisabledMessage();
}
```

```ts
import {BackendError} from '@mndw/sdk';

function handleError(err: unknown): void {
  if (err instanceof BackendError && err.code === 'DISABLED') {
    console.info(err.message);
  }
}
```

`code` is a `BackendErrorCode`. See the [frontend lifecycle guide](/guides/frontend-lifecycle) for context usage.

## Update test contexts

`createTestPluginContext()` now includes `telemetry.gathering$` and `navigation`. The gathering stream defaults to
never emitting. If you build a `PluginContext` by hand, add both properties.

Before, tests could only use the context fixture for the older APIs:

```ts
import {createTestPluginContext} from '@mndw/sdk/testing';

const fixture = createTestPluginContext();
void fixture.context.telemetry.fetchProjected('1h');
```

Now the fixture supplies both context APIs, and a test can drive the gathering state:

```ts
import {of} from 'rxjs';
import {createTestPluginContext} from '@mndw/sdk/testing';

const fixture = createTestPluginContext({telemetry: {gathering$: of({enabled: false})}});
fixture.context.telemetry.gathering$.subscribe(({enabled}) => console.info(enabled));
fixture.context.navigation.href({kind: 'settings', tab: 'general'});
```

## Use typed host navigation

Hard-coded host paths such as `'/settings/general'` couple a plugin to the host router. Build links with
`ctx.navigation.href()` and handle clicks with `ctx.navigation.navigate()`:

<!-- docs-check: skip -->
```js
const settingsUrl = '/settings/general';
window.location.assign(settingsUrl);
```

```ts
export type HostTarget =
  | {readonly kind: 'dashboard'}
  | {readonly kind: 'packages'}
  | {readonly kind: 'settings'; readonly tab?: 'general' | 'diagnostics' | 'plugins' | 'self-update'}
  | {readonly kind: 'plugin-page'; readonly plugin: string; readonly path?: string};

export interface HostNavigation {
  href(target: HostTarget): string | undefined;
  navigate(target: HostTarget): boolean;
}
```

`plugin` is a page plugin's manifest name. Its optional `path` is relative to that plugin's base route and follows the
same restrictions as `PageRoute.navigate`: no scheme, `..`, query, or fragment tricks. `href()` returns `undefined`
for unknown targets; `navigate()` returns `false` without navigating.

This Vue example renders the anchor only when a URL is available and prevents the default action only when the host
handles navigation. See [Linking to host pages](/guides/frontend-lifecycle#linking-to-host-pages) for supported
targets and path rules:

<!-- docs-check: skip -->
```vue
<a v-if="settingsHref !== undefined" :href="settingsHref" @click="openSettings">
  General settings
</a>

<script setup lang="ts">
const settingsTarget = {kind: 'settings', tab: 'general'} as const;
const settingsHref = ctx.navigation.href(settingsTarget);

function openSettings(event: MouseEvent): void {
  if (ctx.navigation.navigate(settingsTarget)) {
    event.preventDefault();
  }
}
</script>
```

## Show telemetry collection state

`ctx.telemetry.gathering$` emits the current state once known, then each change, and completes when the plugin
unmounts. It lets a plugin keep a collection status note up to date.

In 0.1, a plugin could read collection state from a projected snapshot, but not subscribe to changes:

```ts
const snapshot = await ctx.telemetry.fetchProjected('1h');
container.dataset.telemetryEnabled = String(snapshot.gathering.enabled);
```

The collection-state stream uses these types:

```ts
import type {Observable} from 'rxjs';
import type {TelemetryClient} from '@mndw/sdk';

export interface TelemetryGathering { readonly enabled: boolean }
export interface PluginTelemetry extends TelemetryClient {
  /** Emits the current gathering state once it is known, then every change; completes on unmount. */
  readonly gathering$: Observable<TelemetryGathering>;
}
```

Subscribe to show a note while collection is off:

<!-- docs-check: skip -->
```ts
const note = container.querySelector<HTMLElement>('[data-telemetry-note]');

ctx.telemetry.gathering$.subscribe(({enabled}) => {
  if (note !== null) {
    note.hidden = enabled;
    note.textContent = enabled ? '' : 'Telemetry collection is off.';
  }
});
```

## Customize chart tooltips

Both `<mndw-line-chart>` and `<mndw-bar-chart>` now accept a property-only `tooltipFormatter`. Return a title and rows
to customize the tooltip, or return `null` to hide it while keeping the cursor. The formatter receives raw sample
values; formatter errors fall back to the default tooltip. See the [line chart guide](/ui/line-chart) and
[bar chart guide](/ui/bar-chart) for examples and details.

Assign a formatter to provide custom labels and values:

```js
const chart = document.querySelector('mndw-line-chart');

if (chart !== null) {
  chart.tooltipFormatter = ({time, samples}) => ({
    title: new Date(time).toLocaleTimeString(),
    rows: samples.map(({label, value}) => ({label, value: `${value} Mbps`})),
  });
}
```
