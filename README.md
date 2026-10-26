# mndw

mndw is a modular, plugin-based web dashboard for Keenetic/Netcraze network devices.
The browser host provides the dashboard and plugin UI; `mndwd` provides
device-side plugin management and backend execution.

## Architecture

```text
browser
  └─ mndwd
      ├─ static dashboard and plugin assets
      ├─ rci/ and auth/ proxy
      └─ API and WebSocket gateway
```

The Svelte 5 host owns login state, routing, dashboard tiles, plugin rendering,
overlays, theme, and settings. `mndwd` owns plugin files, manifests, approval,
backend processes, HTTP endpoints, WebSockets, and management APIs.
Request routing, listener ports, and upstream targets are owned by
[`contracts/routing.md`](contracts/routing.md).

## Quick start

Prerequisites: Node 22+, pnpm 10+, Go 1.26+.

```bash
git clone git@github.com:Eralde/mndw.git
pnpm install
pnpm dev
```

Development starts the host and connects browser traffic to a local `mndwd --dev`
daemon and a real device. Set `MNDW_HOST_DEVICE=<DEVICE_URL>` to proxy requests
to that device, for example `MNDW_HOST_DEVICE=http://192.168.1.1`.

## Plugin authoring

```bash
pnpm exec mndw create my-widget --framework svelte --type widget
pnpm exec mndw dev my-widget
pnpm exec mndw validate my-widget
pnpm exec mndw pack my-widget
pnpm exec mndw zip my-widget
```

The normal loop is `create -> dev -> validate -> pack -> zip -> upload`.
Plugins use `@mndw/sdk`, implement `createInstance`, and declare a `manifest.json`.
Widgets use grid-unit dimensions; pages declare one root route. Plugin frontend
can be vanilla TypeScript, Svelte, Vue, or Angular. For more details see the
[SDK plugin-author guide](frontend/sdk/README.md).

Plugins can use the host-provided `context.rciManager` to access the existing
device `rci/` API.

### Backends

Plugins may declare an optional backend in `manifest.json`. `exec` backends run
one command per declared HTTP route; `service` backends run a resident process
that exposes HTTP/WebSocket routes. Frontends call declared routes through
`context.backend.fetch(id)` or `context.backend.socket(id)`. Backend processes
require approval and run with daemon/device privileges.

See the [plugin author guide](docs/plugin-author-guide.md) for exec backends
and the [service backend guide](docs/service-backend.md) for service manifests,
socket readiness, lifecycle, and security details.

## IPK build

```bash
pnpm build-ipk --arch mipsel
pnpm build-ipk --all
pnpm build-ipk --all --repo
```

Output: `out/mndw_<version>_<opkg-arch>.ipk` (for example,
`mndw_<version>_mipsel-3.4.ipk`). Builds require a Go cross-compile toolchain.

## License

MIT. See [LICENSE](LICENSE).

## Project layout

```text
frontend/
  angular-compiler/ shared Angular build-time compiler
  sdk/              plugin contracts, manifest schema, backend client, and design tokens
  host/             Svelte 5 host application
  ui/               reusable Lit custom elements and components
  ui-angular/       Angular UI adapter
  ui-svelte/        Svelte UI adapter
  ui-vue/           Vue UI adapter
tooling/
  cli/              `mndw` CLI and plugin packaging
  eslint/           shared ESLint rules
  go-blanklr/       Go blank-line formatter
  palette-core/     dependency-free palette leaf
daemon/
  mndwd/            Go device control plane
  contracts-go/     generated Go contract bindings
packages/
  go-httpsocket/    shared Unix-socket HTTP lifecycle
  go-mws-members/   shared mesh-member parsing
  go-rci/           shared RCI client and transport
  go-rcisock/       shared persistent RCI transport
plugins/
  builtin/          shipped built-in plugins
  examples/         uploadable example plugins
build/
  palette/          palette engine and token generator
  packaging/        web server init, IPK, and install scripts
  ...               repository build orchestration and helpers
docs/               documentation
```

## Documentation

[Host application](docs/host-app.md) <br/>
[Plugin system](docs/plugin-system.md) <br/>
[Plugin author guide](docs/plugin-author-guide.md) <br/>
[CLI and development](docs/cli-and-development.md) <br/>
[Daemon](docs/daemon.md) <br/>
[Deployment](docs/deployment.md) <br/>
