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
| `manifestVersion` | `2`                    | yes      | Always 2                   |
| `name`            | string                 | yes      | `^[a-z0-9][a-z0-9-]*$`     |
| `version`         | string                 | yes      | Semver                     |
| `type`            | `"widget"` or `"page"` | yes      |                            |
| `label`           | string                 | yes      | Human-readable             |
| `entry`           | string                 | yes      | Relative path to JS bundle |
| `icon`            | string?                | no       |                            |

Widgets: `size: { w, h, minW?, minH? }` in grid units (12-column grid). Pages: `route` (single
segment, reserved: `/`, `/login`, `/settings`).

Backend (optional): `opkg`, `scripts`, `endpoints`, `websockets`, `daemon`, `public`.

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

```ts
import {EnvironmentInjector, createComponent} from '@angular/core'
import {createApplication} from '@angular/platform-browser'
import 'zone.js'
import '@angular/compiler'
import {AppComponent} from './app.component'

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  let appRef: Awaited<ReturnType<typeof createApplication>> | null = null;
  let componentRef: ReturnType<typeof createComponent> | null = null;

  void createApplication().then((ref) => {
    appRef = ref;

    const injector = ref.injector.get(EnvironmentInjector);

    el.innerHTML = '';
    componentRef = createComponent(AppComponent, {hostElement: el, environmentInjector: injector});
    componentRef.setInput('deviceName', ctx.hostInfo.deviceName);

    ref.attachView(componentRef.hostView);
  })

  return {
    unmount() {
      componentRef?.destroy();
      appRef?.destroy();

      el.innerHTML = '';
    },
  };
}
```

## 5. PluginContext API

```ts
interface PluginContext {
  rciManager: RciManager;
  sessionManager: SessionManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  injector: ServiceInjector;
  instanceId: string;
  backend?: BackendClient;
  overlay: OverlayService;

  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
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

## 6. Backend Client

```ts
interface BackendClient {
  fetch(id: string, options?: BackendFetchOptions): Promise<Response>;
  socket(id: string, options?: BackendSocketOptions): WebSocket;
}
```

The method and relative path come from endpoint declaration in manifest. Typed errors:
`BackendNotApproved`, `BackendDisabled`, `BackendUnknownId`.

```ts
const client = context.backend;

if (client) {
  const res = await client.fetch('stats');
  const socket = client.socket('term');

  void res;
  void socket;
}
```

## 7. Design Tokens

Style with `var(--mndw-*)` custom properties (auto-themed light/dark):

```css
.my-widget {
  background: var(--mndw-surface);
  color: var(--mndw-text-subtle);
  border: 1px solid var(--mndw-border);
}
```

Full reference: `@mndw/sdk/tokens` (typed) and `@mndw/sdk/tokens.css` (CSS properties).

## 8. Externals Policy

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

## 9. Packing & Uploading

```bash
mndw pack my-widget   # bundle → my-widget/dist/
mndw zip my-widget    # pack + create my-widget/my-widget.zip
```

Upload via dashboard Settings or:

```bash
curl --data-binary @my-widget.zip http://<device>:99/api/mgmt/upload
```

Each zip includes `mndw.lock.json` with exact shared dependency versions.

## 10. Examples

`example-plugins/` in repo:

- `demo-page`
- `device-traffic-widget`
- `device-info-widget`
- `tx-rx-chart-widget`
- `backend-echo`
- `ttyd-widget`
- `ping-widget`
- `clock-widget`
- `dns-lookup-widget`
- `mws-map-page`
