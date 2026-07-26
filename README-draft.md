# mndw v2

> Draft overview for newcomers, contributors, and plugin authors.

mndw is a plugin-based web interface for a network device. It gives users a
dashboard for device tools, while letting authors add widgets and pages without
modifying the host application.

The app has two runtime halves:

- A Svelte 5 SPA runs in the browser. It owns login state, routing, the grid
  dashboard, plugin rendering, overlays, theme, and settings.
- `mndwd` runs on the device. It owns plugin files, manifests, approval,
  backend processes, HTTP endpoints, WebSockets, and management APIs.

lighttpd exposes both halves on device port `:99`:

```text
browser
  └─ lighttpd :99
      ├─ static SPA, /plugins, /user-plugins
      ├─ /rci, /ci, /auth ───────── router services
      └─ /api, /ws ─────── mndwd :9090
```

## What users can do

Users can open a dashboard, add multiple instances of widgets, resize and
persist tiles, navigate to plugin pages, change theme, and manage installed
plugins. A plugin can read device data through the host's RCI/session services
and can open host-owned overlays.

Backend-enabled plugins can expose shell-backed HTTP endpoints, proxy a
declared WebSocket target, install declared opkg packages, or run a long-lived
daemon through start and stop hooks. Backend capabilities are reviewed before
an uploaded plugin is installed.

## What plugin authors do

Authors create a plugin with the `mndw` CLI, implement `createInstance`, write
a v2 `manifest.json`, and use `@mndw/sdk` contracts. The normal loop is:

```text
mndw create → mndw dev → mndw validate → mndw pack → mndw zip → upload
```

Plugins may be vanilla TypeScript, Svelte, Vue, or Angular. Widgets declare
grid-unit dimensions. Pages declare one route. Backend paths are relative;
`mndwd` adds the plugin namespace, so a plugin cannot claim another plugin's
URL space.

## Main runtime flows

On startup, the host checks the router session, obtains device information,
loads the daemon's plugin list, and registers enabled plugins. Widget tiles
mount plugin instances into host-owned frames. Page plugins become routes.

For a backend call, the SDK resolves a declared endpoint id from the descriptor
snapshot. It checks approval and enabled state locally, then calls a namespaced
daemon route. The daemon checks session/public access and enforces the current
state before executing the script or opening the WebSocket proxy.

For an upload, the daemon validates the zip and manifest, puts backend plugins
in staging, reports declared capabilities, and waits for approval. Approval
moves the plugin into the user plugin directory, installs dependencies, starts
its daemon hook when needed, and records the change in state.

## Current status

The Phase 0–5e work recorded in the session notes is implemented and verified:

- workspace and SDK contracts;
- Go daemon state, management, dispatch, WebSocket proxy, auth, opkg, and
  lifecycle;
- host shell, plugin runtime, grid dashboard, example plugins, and dev serving;
- CLI `create`, `dev`, `validate`, `pack`, `zip`, and repository dev loop.

Phase 6 backend-flow work is planned next. It covers the plugin manager UI,
backend-echo, ping and ttyd ports, and BusyBox CI. See
[`docs/testing-and-status.md`](docs/testing-and-status.md) for verification
details and known gaps.

## Documentation map

- [`docs/host-app.md`](docs/host-app.md) — browser application and UI runtime.
- [`docs/plugin-system.md`](docs/plugin-system.md) — SDK and plugin contract.
- [`docs/daemon.md`](docs/daemon.md) — device-side control and data plane.
- [`docs/cli-and-development.md`](docs/cli-and-development.md) — author loop
  and local development.
- [`docs/deployment.md`](docs/deployment.md) — router packaging and install.
- [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md) — practical
  plugin authoring guide.
- [`docs/testing-and-status.md`](docs/testing-and-status.md) — test map,
  project status, and caveats.
