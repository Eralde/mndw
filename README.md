# mndw

mndw is a modular, plugin-based web dashboard for Keenetic network devices.
The browser host provides the dashboard and plugin UI; `mndwd` provides
device-side plugin management and backend execution.

## Architecture

```text
browser
  └─ lighttpd :99
      ├─ static SPA, /plugins, /user-plugins
      ├─ /rci, /ci, /auth ───── router services
      └─ /api, /ws ───────────── mndwd :9090
```

The Svelte 5 host owns login state, routing, dashboard tiles, plugin rendering,
overlays, theme, and settings. `mndwd` owns plugin files, manifests, approval,
backend processes, HTTP endpoints, WebSockets, and management APIs.

## Quick start

Prerequisites: Node 22+, pnpm 10+, Go 1.26+.

```bash
git clone <repo-url>
pnpm install
pnpm dev
```

The host opens at `http://localhost:5173`. Development proxies `/api` and
`/ws` to a local `mndwd --dev` daemon, and `/rci` and `/auth` to a real device.
Set `MNDW_HOST_DEVICE` to select that device.

## Plugin authoring

```bash
npx mndw create my-widget --framework svelte --type widget
npx mndw dev my-widget
npx mndw validate my-widget
npx mndw pack my-widget
npx mndw zip my-widget
```

The normal loop is `create → dev → validate → pack → zip → upload`. Plugins use
`@mndw/sdk`, implement `createInstance`, and declare a v2 `manifest.json`.
Widgets use grid-unit dimensions; pages declare one route. Plugins can be
vanilla TypeScript, Svelte, Vue, or Angular.

See the [SDK plugin-author guide](packages/sdk/README.md).

## IPK build

```bash
pnpm build-ipk --arch mipsel-3.4
pnpm build-ipk --all
pnpm build-ipk --all --repo
```

Output: `out/mndw_<version>_<arch>.ipk`. Builds require a Go cross-compile
toolchain.

## Project layout

```text
packages/
  sdk/              plugin contracts and backend client
  host/             Svelte host application
  ui/               reusable custom elements
  cli/              plugin scaffolding and packaging
  daemon/           Go device control plane
  go-device-auth/   shared device-auth handshake
  go-rcisock/       shared persistent RCI transport
example-plugins/    framework and backend examples
deploy/             lighttpd, init, IPK, install scripts
tools/              palette, development, and IPK build tools
docs/               documentation
```

## Documentation

[Host application](docs/host-app.md)
[Plugin system](docs/plugin-system.md)
[Plugin author guide](docs/plugin-author-guide.md)
[CLI and development](docs/cli-and-development.md)
[Daemon](docs/daemon.md)
[Deployment](docs/deployment.md)
