# @mndw/sdk — Plugin Author Guide

The mndw host loads plugins as dashboard widgets or full-page routes.

## 1. What is mndw?

One SPA. Plugins are dashboard widgets or full-page routes loaded dynamically. This guide covers the
`@mndw/sdk` package — everything a plugin author needs.

## 2. Getting Started

```bash
pnpm exec mndw create my-widget --framework svelte --type widget
```

Scaffolds: `manifest.json`, `src/index.ts`, `src/App.svelte`, `src/index.css`.

## 3. Manifest Reference

| Field             | Type                   | Required | Description                |
|-------------------|------------------------|----------|----------------------------|
| `manifestVersion` | `3`                    | yes      | Always 3                   |
| `name`            | string                 | yes      | `^[a-z0-9][a-z0-9-]*$`     |
| `version`         | string                 | yes      | Semver                     |
| `type`            | `"widget"` or `"page"` | yes      |                            |
| `label`           | string                 | yes      | Human-readable             |
| `entry`           | string                 | yes      | Relative path to JS bundle |
| `icon`            | string?                | no       |                            |

Widgets: `size: { w, h, minW?, minH? }` in grid units (12-column grid). Pages: `route` (single
segment, reserved: `/`, `/login`, `/settings`).

Backend (optional): `kind: "exec"` with HTTP route commands, or `kind: "service"`
with one foreground command, protocol version, and HTTP/WebSocket routes.
Commands are relative executable paths; service args are literal values.

## 4. Plugin Module

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk'

export function createInstance(
  container: HTMLElement,
  context: PluginContext,
): PluginInstance | Promise<PluginInstance> {
  return {
    unmount() {
      // Clean up DOM, dispose framework component.
      // Return type: void | Promise<void>
    },
    onResize(size: {w: number; h: number}) {
      // Optional widget resize callback.
      void size
    },
  };
}
```

### Svelte (Svelte 5)

```ts
import {mount, unmount} from 'svelte'
import App from './App.svelte'

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {ctx}});

  return {
    unmount() {
      void unmount(app);
    },
  };
}
```

### Vue

```ts
import {createApp} from 'vue'
import App from './App.vue'

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = createApp(App, {ctx});

  app.mount(container);

  return {
    unmount() {
      app.unmount()
    },
  };
}
```

### Angular

`@mndw/sdk/angular` provides optional helpers for common Angular plugin lifecycle work. Authors can
still use Angular APIs directly when they need different application or component management; these
helpers reduce repeated mounting and teardown boilerplate.

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance, provideTranslator} from '@mndw/sdk/angular';
import 'zone.js'
import '@angular/compiler'
import {AppComponent} from './app.component'

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  return createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [provideTranslator(ctx.i18n)],
    configure: ({component}) => {
      component.setInput('deviceName', ctx.hostInfo.deviceName);
    },
  });
}
```

The helper owns application creation, root view attachment, cancellation when unmounted before
bootstrap completes, mount-failure cleanup, and component/application teardown. Include
`provideTranslator(ctx.i18n)` when the component tree injects the SDK `TRANSLATOR` token.

For a component opened through the host-managed overlay service, use the optional
`mountComponentInOverlay` helper. Pass `appRef` from the root helper's `configure` callback and let
the overlay layer own cleanup; return subscription cleanup from `setup` when needed:

```ts
import {mountComponentInOverlay} from '@mndw/sdk/angular';

configure: ({appRef, component}) => {
  component.setInput('openSettings', () => {
    ctx.overlay.open({
      kind: 'modal',
      title: 'Settings',
      mount(target, layer) {
        mountComponentInOverlay({
          appRef,
          target,
          layer,
          component: SettingsComponent,
          setup: (ref) => {
            ref.setInput('value', 'current');

            return () => {
              // Unsubscribe from plugin-owned subscriptions here.
            };
          },
        });
      },
    });
  });
}
```

`mountComponentInOverlay` attaches the child view and registers detach/destroy cleanup with the
layer. Direct Angular mounting remains supported when this lifecycle does not fit the plugin.

## 5. Worker-backed ticker

Use `@mndw/sdk/ticker` for drift-corrected periodic updates. Scheduling runs in a dedicated
WebWorker, so plugin code does not own timer logic or worker protocol details.

```ts
import {Ticker} from '@mndw/sdk/ticker'

const ticker = new Ticker()
const unsubscribe = ticker.onTick(() => {
  // Update plugin state.
})

ticker.start(1000)

// During plugin teardown:
unsubscribe()
ticker.destroy()
```

`Ticker.destroy()` stops and terminates its worker. The CLI packer includes the SDK worker in the
plugin distribution automatically.

## 6. PluginContext API

```ts
type PluginContext = WidgetPluginContext | PagePluginContext;

interface WidgetPluginContext {
  kind: 'widget';
  rciManager: RciManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  i18n: PluginI18n;
  injector: ServiceInjector;
  instanceId: string;
  backend?: BackendClient;
  overlay: OverlayService;
  setTileTitle?: (title: string) => void;
  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
  getTokens(): PaletteTokenMap;
  onPaletteChange(callback: (tokens: PaletteTokenMap) => void): () => void;
  // pageRoute is unavailable on widget contexts.
}

interface PagePluginContext {
  kind: 'page';
  rciManager: RciManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  i18n: PluginI18n;
  injector: ServiceInjector;
  instanceId: string;
  backend?: BackendClient;
  overlay: OverlayService;
  pageRoute: PageRoute;
  // setTileTitle is unavailable on page contexts.
  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
  getTokens(): PaletteTokenMap;
  onPaletteChange(callback: (tokens: PaletteTokenMap) => void): () => void;
}

interface PageRoute {
  readonly childPath$: Observable<string>;
  navigate(
    childPath: string,
    options?: {replace?: boolean; scrollToTop?: boolean},
  ): Promise<void>;
}

type PageRouteErrorCode = 'INVALID_PATH' | 'COMPLETED' | 'NAVIGATION_FAILED';

class PageRouteError extends Error {
  readonly code: PageRouteErrorCode;
}

interface HostInfo {
  deviceName: string;
  vendor: string;
  firmwareVersion: string;
  theme: MndwThemeName;
}

interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

`PluginContext` is host-created. Narrow variant-specific fields with `context.kind`; plugins do not
author the discriminant. `success` means current settled data, `refreshing` retains prior data while
a request is active, and `error` may retain prior data after a failed refresh. `unsupported` is a
terminal capability outcome for that plugin lifetime.

## 6.1 Canonical async state

```ts
type LoadState<T, E = unknown> =
  | {status: 'idle'}
  | {status: 'loading'}
  | {status: 'success'; data: T}
  | {status: 'refreshing'; data: T}
  | {status: 'error'; error: E; data?: T}
  | {status: 'unsupported'; reason: string};
```

Reducers must carry `data` into `error` whenever the failed request started from a state that had
data. Initial `idle`/`loading` failures may omit it.

## Localization

`PluginContext.i18n` is required. It is a synchronous `PluginI18n` snapshot for the committed host
locale. Catalog JSON is nested; dotted lookup uses the path through that tree, and hyphens separate
words inside one key part:

```json
{
  "wifi": {
    "encryption": {"disabled": "Unsecured"},
    "band": {"2": "2.4 GHz Wi-Fi"}
  },
  "error": {"integer-only": "Only integer values are allowed"}
}
```

Use `wifi.encryption.disabled`, `wifi.band.2`, and `error.integer-only` in code. `i18n.t()` returns
the raw key when no catalog value exists; it never renders an empty string. `formatNumber()` and
`formatDate()` follow the committed host locale. `direction` is the reserved literal `'ltr'`; RTL is
out of scope for this plan.

Use framework helpers so child components observe the same locale revision:

```svelte
<script lang="ts">
  import type {PluginI18n} from '@mndw/sdk';
  import {createTranslator} from '@mndw/sdk/svelte';

  let {i18n}: {i18n: PluginI18n} = $props();
  const translator = createTranslator(i18n);
</script>

<h1>{$translator.t('wifi.encryption.disabled')}</h1>
```

```ts
import {useTranslator} from '@mndw/sdk/vue';

const translator = useTranslator(props.ctx.i18n);
const label = translator.t('wifi.band.2');
```

```ts
import {DestroyRef, inject} from '@angular/core';
import {createTranslatorSignals} from '@mndw/sdk/angular';

const translator = createTranslatorSignals(ctx.i18n, inject(DestroyRef));
```

```ts
import {bindLocale} from '@mndw/sdk/bind-locale';

const unsubscribe = bindLocale(ctx.i18n, render);
// Call unsubscribe from PluginInstance.unmount().
```

Angular plugins provide one translator through their root `TRANSLATOR` token and child components
inject that token. Svelte children receive the translator store/helper, not raw `PluginI18n`.
Vanilla translation calls belong in audited render modules with `bindLocale` teardown. Template-
reachable code must not call raw `PluginI18n.t`, `formatNumber`, or `formatDate`; the typed lint rule
enforces this for Svelte and Angular, with the MWS tile-label adapter as an explicit exemption.

The Vue SFC parser remains outside typed enforcement and has no textual raw-i18n rule. Generated
locale-switch tests and the packed smoke test provide behavioral coverage for Vue.

Shared catalog parsing is available from `@mndw/sdk/catalog`:

```ts
import {parseCatalog} from '@mndw/sdk/catalog';

const catalog = parseCatalog({wifi: {band: {'2': '2.4 GHz Wi-Fi'}}}, '<catalog>');
```

`@mndw/sdk/testing` exports `createTestI18n`, accepting either nested catalogs like production or
flat dotted-key maps for terse tests. Every generated/plugin/packed smoke probe must have different
English and Russian values and assert `enValue !== ruValue` before switching; otherwise a test could
pass without proving that the DOM reacted.

### Overlay

```ts
interface OverlayService {
  createLayer<Result>(options: OverlayLayerOptions): OverlayLayer<Result>;
  open<Result>(options: OverlayOpenOptions<Result>): OverlaySession<Result>;
  closeAll(): void;
}
```

`OverlayOpenOptions` requires `kind` (`"modal"` or `"drawer"`), `title?`, `description?`,
`showCloseButton?`, and a `mount(target, layer, signal)` callback.

## 7. Backend Client

```ts
interface BackendClient {
  fetch(id: string, options?: BackendFetchOptions): Promise<Response>;
  socket(id: string, options?: BackendSocketOptions): WebSocket;
}
```

The method and relative path come from endpoint declaration in manifest. Typed errors include
descriptor errors (`BackendNotApproved`, `BackendDisabled`, `BackendUnknownId`, and
`BackendTransportMismatch`) plus daemon lifecycle errors:
`BackendStarting`, `BackendUnavailable`, `BackendIncompatible`, `BackendMaintenance`, and
`BackendBadGateway`. Lifecycle errors carry `id` and literal `daemonCode`; starting and
maintenance also carry parsed integer `retryAfterSeconds` or `null`.

Page plugins use `context.pageRoute` for child routes. `childPath$` emits the normalized child
pathname (for example, `/clients`) and `navigate()` accepts a child pathname without query or
hash. It preserves valid ordinary percent encoding such as `%20`, rejects malformed or ambiguous
paths, and returns a rejected promise with `PageRouteError` (`INVALID_PATH`, `COMPLETED`, or
`NAVIGATION_FAILED`) when navigation cannot proceed. `scrollToTop` defaults to `true`.

```ts
const client = context.backend;

if (client) {
  try {
    const res = await client.fetch('stats');
    void res;
  } catch (error) {
    if (error instanceof BackendNotApproved || error instanceof BackendDisabled) {
      // Show approval/availability UI.
    } else if (error instanceof BackendStarting || error instanceof BackendMaintenance) {
      // Show retrying UI; retryAfterSeconds is informational in this slice.
    } else if (error instanceof BackendUnavailable || error instanceof BackendIncompatible
      || error instanceof BackendBadGateway) {
      // Classify daemon lifecycle state or degraded transport.
    } else if (error instanceof BackendUnknownId || error instanceof BackendTransportMismatch) {
      // Fix a stale declaration or route transport mismatch.
    }
  }
}
```

## 8. Design Tokens

Style with `var(--mndw-*)` custom properties (auto-themed light/dark):

```css
.my-widget {
  background: var(--mndw-surface);
  color: var(--mndw-text-subtle);
  border: 1px solid var(--mndw-border);
}
```

Full reference: `@mndw/sdk/tokens` (typed) and `@mndw/sdk/tokens.css` (CSS properties).

For runtime JavaScript colours, use `context.getTokens()` and subscribe with
`context.onPaletteChange(...)`. `MNDW_TOKENS` contains compiled defaults only and does not
include a device palette override.

## 9. Externals Policy

Host-provided, must NOT be bundled:

| Package                                                                                         | Applies to           |
|-------------------------------------------------------------------------------------------------|----------------------|
| `@rci-tools/core`, `rxjs`, `rxjs/operators`, `hash-wasm`, `d3`                                  | all plugins          |
| `vue`                                                                                           | Vue plugins only     |
| `zone.js`, `@angular/core`, `@angular/common`, `@angular/platform-browser`, `@angular/compiler` | Angular plugins only |

CLI enforces at pack time.

### D3 and extensions

The host provides the complete `d3@7.9.0` package as one shared bundle. Use the normal package import:

```ts
import * as d3 from 'd3';
```

All official d3 APIs, including `zoom`, are available from that namespace. Keep `d3` and `@types/d3` in `devDependencies` so local tests and type checking resolve the package; `mndw pack` externalizes it and the host import map supplies it at runtime.

Third-party extensions are not automatically host-provided. Declare an extension such as `d3-dag` in your plugin and let the packer bundle it. Any package not listed in the host shared-dependency table follows this same fallback rule; using it never requires a host release. Do not separately bundle official d3 modules already exposed by the full `d3` namespace.

## 10. Packing & Uploading

```bash
mndw pack my-widget   # bundle → my-widget/dist/
mndw zip my-widget    # pack + create my-widget/my-widget.zip
```

Upload via dashboard Settings or:

```bash
curl --data-binary @my-widget.zip http://<device>:99/api/mgmt/upload
```

Each zip includes `mndw.lock.json` with exact shared dependency versions.

## 11. Examples

Built-in plugins in `plugins/builtin/`:

- `device-info-widget`
- `tx-rx-chart-widget`
- `terminal-page`
- `clock-widget`
- `dns-lookup-widget`
- `mws-page`

Uploadable examples in `plugins/examples/`:

- `backend-echo`
- `demo-page`
- `device-traffic-widget`
- `ping-widget`
