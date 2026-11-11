# Frontend lifecycle

The host calls `createInstance(container, ctx)` once for each mounted plugin instance. It may return a
`PluginInstance` or a promise for one. Return an object with `unmount()` so framework roots, DOM listeners, and work
the plugin started can be released; `unmount()` may also return a promise. Widgets may implement
`onResize({w, h})`; dimensions are grid units. Pages do not receive widget resize calls.

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  ctx.theme$.subscribe((theme) => {
    container.dataset.theme = theme;
  });
  ctx.palette$.subscribe((palette) => {
    container.dataset.paletteTokenCount = String(Object.keys(palette).length);
  });

  const ticker = ctx.createTicker();
  ticker.start(1000);
  ticker.tick$.subscribe(({timestamp}) => {
    container.dataset.lastTick = String(timestamp);
  });

  return {
    onResize({w, h}): void {
      container.dataset.size = `${w}x${h}`;
    },
    unmount(): void {
      container.replaceChildren();
    },
  };
}
```

## Context streams

The live getters `ctx.theme`, `ctx.locale`, and `ctx.palette` return the current snapshot. Subscribe to
the corresponding Observable when the UI needs updates over time. This table shows whether each stream
emits its current value on subscribe:

| Stream | Emits | Current value on subscribe? |
| --- | --- | --- |
| `ctx.theme$` | Current host theme and later theme changes | Yes |
| `ctx.locale$` | Current host locale and later locale changes | Yes |
| `ctx.palette$` | Current applied palette and later palette changes | Yes |
| `ctx.i18n.change$` | A signal when the catalog or host locale changes | No |
| `ctx.pageRoute.childPath$` | Current page child path and later navigation | Yes; pages only |
| `ctx.events?.select$(topics)` | Events matching the selected topics | No; with event permissions |
| `ctx.events?.resync$` | A signal to refresh after an event-stream resync | No; with event permissions |
| `ticker.tick$` | Periodic ticks after `ticker.start()` | No |

The host completes every stream it handed you on unmount. You do not need to unsubscribe from those
context streams; unsubscribe temporary subscriptions for work you started, such as timers or request
streams. Each `ctx.createTicker()` call returns one handle for a ticker use. The host destroys every
handle on unmount, and its `tick$` completes then too.

`ctx.pageRoute` exists only for page plugins. `ctx.events` exists only when the manifest declares
event permissions, and `ctx.backend` exists only when the manifest declares callable backend routes.
Check the context kind before using a page route, and narrow optional services before calling them:

```ts
if (ctx.kind === 'page') {
  void ctx.pageRoute.navigate('/details');
}

ctx.events?.select$('wan').subscribe((event) => {
  console.info(event.topic);
});

if (ctx.backend !== undefined) {
  void ctx.backend.fetch('status');
}
```

## Cancellation and resource ownership

The host aborts `ctx.signal` with a standard `AbortError` DOMException when it disposes a context: widget removal,
leaving a page, plugin reload, or disable. Pass it to cancellable requests, and check `ctx.signal.aborted` after every
`await` in asynchronous `createInstance` work before updating UI or starting more work.

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk';

export async function createInstance(container: HTMLElement, ctx: PluginContext): Promise<PluginInstance> {
  if (ctx.backend === undefined) {
    throw new Error('This plugin needs a backend route');
  }

  try {
    const response = await ctx.backend.fetch('status', {signal: ctx.signal});
    if (ctx.signal.aborted) {
      return {unmount() {}};
    }

    const status = await response.json();
    if (ctx.signal.aborted) {
      return {unmount() {}};
    }

    container.textContent = JSON.stringify(status);
  } catch (error) {
    if (!ctx.signal.aborted) {
      throw error;
    }

    return {unmount() {}};
  }

  return {unmount() { container.replaceChildren(); }};
}
```

| Resource owner | Resources | Cleanup |
| --- | --- | --- |
| Host | Context streams, tickers, overlays, event facades | Ended or disposed automatically with context |
| Plugin | Fetch/backend/telemetry requests, sockets, retry/polling loops, own timers, RCI subscriptions | Pass `ctx.signal` where supported; otherwise listen for its `abort` event or clean up in `unmount()` |

The host disposes context immediately even while `createInstance` is pending. If initialization later returns an instance,
the host calls its `unmount()`; `ctx.signal` lets the plugin stop work before that promise settles.

## Linking to host pages

Use `ctx.navigation` to link to the dashboard, packages, settings (optionally a tab), or an installed, routable page
plugin by manifest name. A plugin-page `path` is relative to that page's base route: no leading slash, `.` or `..`
segments, query (`?`) or fragment (`#`), URL scheme, or backslash. For an unknown target, including an uninstalled or
non-routable page plugin, `href()` returns `undefined` and `navigate()` returns `false`; neither throws.

Render an anchor only when `href()` returns a URL. Prevent its default action only when `navigate()` handles the click:

<!-- docs-check: skip -->
```vue
<script setup lang="ts">
import type {PluginContext} from '@mndw/sdk';

const {ctx} = defineProps<{ctx: PluginContext}>();
const target = {kind: 'settings', tab: 'general'} as const;
const href = ctx.navigation.href(target);

function openSettings(event: MouseEvent): void {
  if (ctx.navigation.navigate(target)) {
    event.preventDefault();
  }
}
</script>

<template>
  <a v-if="href !== undefined" :href="href" @click="openSettings">General settings</a>
</template>
```

`ctx.telemetry.fetchProjected(range)` returns a Promise for projected telemetry data, not a stream. It
accepts an `AbortSignal` when the request should be cancelled during teardown.
Each projected series carries a `unit` string. Known units are `percent` and `celsius`; future or
plugin-specific units pass through unchanged. Show an unknown unit as received, and use
`isKnownTelemetryUnit` when behavior depends on a known unit:

```ts
import {isKnownTelemetryUnit} from '@mndw/sdk';

const unitLabel = (unit: string): string => {
  if (isKnownTelemetryUnit(unit)) {
    return ({percent: '%', celsius: '°C'} as const)[unit];
  }

  return unit;
};

const readUnitLabels = async (): Promise<string[]> => {
  const snapshot = await ctx.telemetry.fetchProjected('1h');

  return Object.values(snapshot.keys).map((series) => unitLabel(series.unit));
};
```

## Framework helpers

Svelte treats an Observable as a store. Assign the context stream to a local store variable, then use
`$theme$` in markup:

```svelte
<script lang="ts">
  import type {PluginContext} from '@mndw/sdk';

  export let ctx: PluginContext;
  const theme$ = ctx.theme$;
</script>

<p>Theme: {$theme$}</p>
```

Vue helpers convert context Observables into scope-bound refs. `useTranslator` makes localization
updates reactive in the same component:

```vue
<script setup lang="ts">
  import type {PluginContext} from '@mndw/sdk';
  import {useLocale, useObservable, useTheme, useTranslator} from '@mndw/sdk/vue';

  const {ctx} = defineProps<{ctx: PluginContext}>();
  const theme = useTheme(ctx);
  const locale = useLocale(ctx);
  const palette = useObservable(ctx.palette$, ctx.palette);
  const translator = useTranslator(ctx.i18n);
</script>

<template>
  <p>{{ theme }} · {{ locale }} · {{ translator.locale }} · {{ Object.keys(palette).length }}</p>
</template>
```

In Angular, `toSignal` exposes an Observable as a signal. `createTranslatorSignals` tracks catalog
changes and ties its subscription to `DestroyRef`:

```ts
import {type DestroyRef} from '@angular/core';
import {toSignal} from '@angular/core/rxjs-interop';
import type {PluginContext} from '@mndw/sdk';
import {createTranslatorSignals} from '@mndw/sdk/angular';

export function pluginState(ctx: PluginContext, destroyRef: DestroyRef): object {
  return {
    theme: toSignal(ctx.theme$, {initialValue: ctx.theme}),
    palette: toSignal(ctx.palette$, {initialValue: ctx.palette}),
    translator: createTranslatorSignals(ctx.i18n, destroyRef),
  };
}
```

Framework adapters should also release their own mount. For example, Svelte's `unmount(app)` may be
asynchronous; return or await that promise if teardown must finish before the host continues. Do not
rely on removing DOM nodes alone to stop plugin-owned work. The
[Hello widget entry](https://github.com/Eralde/mndw/blob/master/plugins/examples/hello-widget/src/index.ts)
shows the Svelte adapter; its component also invalidates an in-flight request on destroy.


## Canonical async state

Use the SDK `LoadState<T, E>` union to represent an asynchronous capability consistently:

```ts
import type {LoadState} from '@mndw/sdk';

const initial: LoadState<string> = {status: 'idle'};
const loading: LoadState<string> = {status: 'loading'};
const ready: LoadState<string> = {status: 'success', data: 'connected'};
const refreshing: LoadState<string> = {status: 'refreshing', data: 'connected'};
const failedRefresh: LoadState<string, Error> = {status: 'error', error: new Error('offline'), data: 'connected'};
const unsupported: LoadState<string> = {status: 'unsupported', reason: 'Not available on this device'};
void [initial, loading, ready, refreshing, failedRefresh, unsupported];
```

A failed refresh retains prior `data`; an initial failure may omit it. `unsupported` is terminal for the plugin
instance lifetime. See the [SDK API](/api/sdk) for the complete union.

## Ticker timing

`ctx.createTicker()` provides drift-corrected periodic updates. The host shares one worker across plugin tickers and
destroys each ticker with its context. `tick$` emits `{timestamp, drift}`; `start(periodMs)` starts it, `setInterval`
changes its period, `stop()` pauses it, and `destroy()` completes its stream. Explicit destruction is optional when
context teardown owns the handle.

```ts
import type {PluginContext} from '@mndw/sdk';

export function startClock(ctx: PluginContext, render: (timestamp: number, drift: number) => void): void {
  const ticker = ctx.createTicker();
  const subscription = ticker.tick$.subscribe(({timestamp, drift}) => { render(timestamp, drift); });
  ticker.start(1000);
  void subscription;
}
```

The host ends the handle on plugin teardown, and plugin bundles do not include the worker. Unsubscribe only work
started by the plugin; context streams complete automatically.

## Plugin translations

`ctx.i18n` is a synchronous `PluginI18n` snapshot for the committed host locale. Catalog JSON is nested; dotted
lookup follows the tree and hyphens remain inside one key part. Missing translations return the raw key rather than
an empty string. `formatNumber()` and `formatDate()` follow the host locale; `direction` is the reserved literal
`'ltr'`.

```json
{
  "wifi": {"encryption": {"disabled": "Unsecured"}, "band": {"2": "2.4 GHz Wi-Fi"}},
  "error": {"integer-only": "Only integer values are allowed"}
}
```

Use `wifi.encryption.disabled`, `wifi.band.2`, and `error.integer-only` as keys. Framework helpers keep child
components in sync: Svelte uses `createTranslator` from `@mndw/sdk/svelte`, Vue uses `useTranslator` from
`@mndw/sdk/vue`, and Angular uses `createTranslatorSignals` from `@mndw/sdk/angular` with `DestroyRef`. Angular roots
can provide one translator with `provideTranslator(ctx.i18n)` and child components inject `TRANSLATOR`. Vanilla code
uses `bindLocale` from `@mndw/sdk/bind-locale` and releases the returned subscription in `unmount()`.

```ts
import {bindLocale} from '@mndw/sdk/bind-locale';

export function bindPluginLocale(i18n: import('@mndw/sdk').PluginI18n, render: () => void): () => void {
  return bindLocale(i18n, render);
}
```

Template-reachable code must use framework helpers or audited vanilla render modules; raw `PluginI18n.t`,
`formatNumber`, and `formatDate` calls are prohibited there. Typed lint enforces this for Svelte and Angular. Vue SFCs
are outside typed enforcement; generated locale-switch tests and packed smoke tests cover their updates. The MWS
tile-label adapter is the explicit lint exemption.

`@mndw/sdk/testing` exports `createTestI18n` for nested or flat dotted-key catalogs and
`createTestPluginContext()` for widget context fixtures. Test English and Russian with distinct values and assert the
values differ before switching locale. The context fixture exposes `setTheme`, `setLocale`, `setPalette`, `unmount`,
`tick`, and, with `{events: true}`, `emitEvent` and `resync`.

```ts
import {createTestPluginContext} from '@mndw/sdk/testing';

const fixture = createTestPluginContext({events: true});
const values: string[] = [];
const subscription = fixture.context.theme$.subscribe((theme) => { values.push(theme); });
fixture.setTheme('dark');
fixture.unmount();
subscription.unsubscribe();
void values;
```

## Angular lifecycle helpers and overlays

`@mndw/sdk/angular` exports `createAngularPluginInstance` and `mountComponentInOverlay`. The root helper owns
application creation, root view attachment, cancellation before bootstrap completes, mount-failure cleanup, and
component/application teardown. Pass `provideTranslator(ctx.i18n)` when the component tree injects `TRANSLATOR`.

For overlay content, `ctx.overlay.open()` accepts modal or drawer options with optional `title`, `description`,
`showCloseButton`, sizing, focus, and dismissal settings, plus a `mount(target, layer, signal)` callback. The signal
aborts when closing starts; use it to cancel work tied to the overlay. Call `mountComponentInOverlay` from the root
helper's `configure` callback with its `appRef`, the overlay `target` and `layer`, and the child component type. The
helper attaches the child view and registers detach/destroy cleanup with the layer. A `setup(ref)` callback may return
a cleanup function for subscriptions. `ctx.overlay.createLayer()` creates popover or custom layers;
`ctx.overlay.closeAll()` closes overlays opened by this plugin instance. The host owns stacking, focus, dismissal,
backdrop, scroll lock, and overlay cleanup; plugins mount content into host-provided targets and register teardown.
Direct Angular mounting remains supported when these helpers do not fit. See the
[Angular SDK API](/api/sdk/angular) and [overlay API](/api/sdk).

## Page routes and backend errors

Page plugins use `ctx.pageRoute` for child paths. `childPath$` emits the normalized pathname; `navigate()` takes a
child pathname without query or hash, preserves ordinary percent encoding such as `%20`, and rejects malformed or
ambiguous paths. Failures use `PageRouteError` codes `INVALID_PATH`, `COMPLETED`, or `NAVIGATION_FAILED`;
`scrollToTop` defaults to `true`.

The optional `ctx.backend` client exposes `fetch`, `socket`, and `status`. Every backend failure extends
`BackendError` and exposes a `code`; switch on it or use `instanceof BackendError`. Codes are
`UNKNOWN_ID` (`BackendUnknownId`), `NOT_APPROVED` (`BackendNotApproved`), `DISABLED` (`BackendDisabled`),
`TRANSPORT_MISMATCH` (`BackendTransportMismatch`), `BACKEND_STARTING` (`BackendStarting`),
`BACKEND_UNAVAILABLE` (`BackendUnavailable`), `BACKEND_INCOMPATIBLE` (`BackendIncompatible`),
`BACKEND_MAINTENANCE` (`BackendMaintenance`), `BACKEND_BLOCKED` (`BackendBlocked`), `BAD_GATEWAY`
(`BackendBadGateway`), and `STATUS_QUERY_FAILED` (`BackendStatusQueryError`). Errors tied to a route carry its
`id`; `BackendStatusQueryError` has no `id` and includes `httpStatus`. Starting and maintenance errors also carry
parsed integer `retryAfterSeconds` or `null`. Handle approval/disabled states as configuration, starting/maintenance
as retryable, and unavailable/incompatible/bad gateway as lifecycle or transport failure. The full error types are in
the [SDK API](/api/sdk).
