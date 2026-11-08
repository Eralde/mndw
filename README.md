# mndw

A modular, plugin-based web dashboard for Keenetic/Netcraze network devices.

[![npm version: @mndw/cli](https://img.shields.io/npm/v/%40mndw%2Fcli)](https://www.npmjs.com/package/@mndw/cli)
[![npm version: @mndw/sdk](https://img.shields.io/npm/v/%40mndw%2Fsdk)](https://www.npmjs.com/package/@mndw/sdk)
[Documentation](https://eralde.github.io/mndw/)

## Install on a router

Install Entware first. Follow the [Entware installation guide][entware].

[entware]: https://support.keenetic.com/titan/kn-1811/en/20980-installing-the-entware-repository-on-a-usb-drive.html

Run this command in the router's OPKG shell:

```sh
opkg update && opkg install wget-ssl ca-bundle && wget -qO- https://eralde.github.io/mndw-opkg-feed/add_repo.sh | sh
```

The script prints the dashboard address, typically `http://<router>:1189`; sign in with the router account. See the
[upgrade and removal instructions](https://eralde.github.io/mndw/install).

## Write a plugin

No repository clone is needed. Build plugins from npm packages in your own Node.js project:

```sh
mkdir my-plugins && cd my-plugins
npm init -y
npm i -D @mndw/cli
npx mndw create my-widget
npx mndw dev my-widget --addr http://router.lan
```

For `--addr`, use an IP, hostname, `host[:port]`, or an HTTP(S) origin. Then run `npx mndw validate my-widget`, create
an upload archive with `npx mndw zip my-widget`, and upload the ZIP in Settings.

Start with the [plugin author site](https://eralde.github.io/mndw/), including the
[Hello Widget tutorial](https://eralde.github.io/mndw/tutorials/hello-widget),
[CLI reference](https://eralde.github.io/mndw/reference/cli), and
[SDK API reference](https://eralde.github.io/mndw/api/sdk).

Plugins can declare `exec` backends for request-scoped commands or `service` backends for long-running processes;
backends need approval before they run. See the
[shell backend guide](https://eralde.github.io/mndw/guides/shell-backend) and, for `service` backends,
[`docs/service-backend.md`](docs/service-backend.md).

## npm packages

| Package | What it is for | When you need it |
| --- | --- | --- |
| `@mndw/cli` | Create, validate, develop, and package plugins. | When building plugins. |
| `@mndw/sdk` | Plugin types, framework helpers, and design tokens. | When using the host context or SDK helpers. |
| `@mndw/ui` | Framework-agnostic custom elements. | When using mndw controls, tables, or charts. |
| `@mndw/ui-svelte` | Svelte table cell adapters for mndw UI. | When rendering Svelte components in mndw tables. |
| `@mndw/ui-vue` | Vue table cell adapters for mndw UI. | When rendering Vue components in mndw tables. |
| `@mndw/ui-angular` | Angular table cell adapters for mndw UI. | When rendering Angular components in mndw tables. |
| `@mndw/palette-core` | Palette math and contract metadata. | Usually pulled in by SDK, CLI, or palette tooling. |

`@mndw/cli` installs the local `mndwd` for your OS through optional `@mndw/mndwd-<os>-<arch>` dependencies: macOS
(arm64 and x64), Linux (arm64 and x64), and Windows (x64). You never install these packages by hand.

All `@mndw/*` packages share one version; `mndw create` writes compatible version ranges.

## Develop mndw

### Quick start

Prerequisites: Node.js 22+, pnpm 10+, and Go 1.26.2+. Older Go 1.26.x builds produce MIPS and MIPSel binaries that
crash at startup on Linux kernels before 5.0 ([golang/go#77730](https://github.com/golang/go/issues/77730)).

```sh
git clone https://github.com/Eralde/mndw.git
cd mndw
pnpm install
pnpm dev
```

Set `MNDW_HOST_DEVICE=http://192.168.1.1` to proxy browser requests to a reachable router during development.

### Architecture

```text
browser
  └─ mndwd
      ├─ static dashboard and plugin assets
      ├─ rci/ and auth/ proxy
      └─ API and WebSocket gateway
```

The Svelte 5 host owns login state, routing, dashboard tiles, plugin rendering, overlays, theme, and settings. `mndwd`
owns plugin files, manifests, approval, backend processes, HTTP endpoints, WebSockets, and management APIs. Request
routing, listener ports, and upstream targets are defined in [`contracts/routing.md`](contracts/routing.md).

### Project layout

```text
contracts/            shared schemas, API contracts, and fixtures
frontend/
  angular-compiler/   shared Angular build-time compiler
  sdk/                published plugin types, helpers, and tokens
  sdk-internal/       internal manifest and package contracts
  host/               Svelte 5 host application
  ui/                 reusable custom elements
  ui-svelte/          Svelte table cell adapter
  ui-vue/             Vue table cell adapter
  ui-angular/         Angular table cell adapter
tooling/
  cli/                `mndw` CLI and plugin packaging
  eslint/             shared ESLint rules
  go-blanklr/         Go blank-line formatter
  palette-core/       dependency-free palette library
daemon/
  mndwd/              Go device control plane
  contracts-go/       generated Go contract bindings
internal/             RCI session lifecycle and state
packages/
  go-httpsocket/      Unix-socket HTTP lifecycle
  go-mws-members/     mesh-member parsing
  go-rci/             shared RCI client and transport
  go-rcisock/         persistent RCI-session framing and client
plugins/
  builtin/            shipped built-in plugins
  examples/           uploadable example plugins
build/                repository build orchestration, npm packaging, and IPK tooling
docs/                 project and plugin-author documentation
```

### IPK build

```bash
pnpm build-ipk --arch mipsel
pnpm build-ipk --all
pnpm build-ipk --all --repo
```

Output: `out/mndw_<version>_<opkg-arch>.ipk` (for example, `mndw_<version>_mipsel-3.4.ipk`). Builds require a Go
cross-compile toolchain.

### Plugins in this repository

Use the workspace CLI:

```bash
pnpm exec mndw create my-widget --framework svelte --type widget
pnpm exec mndw dev my-widget
pnpm exec mndw validate my-widget
pnpm exec mndw pack my-widget
pnpm exec mndw zip my-widget
```

### Documentation

- [Host application](docs/host-app.md)
- [Plugin system](docs/plugin-system.md)
- [CLI and development](docs/cli-and-development.md)
- [Daemon](docs/daemon.md)
- [Deployment](docs/deployment.md)
- [Service backend](docs/service-backend.md)
- [Plugin-author site source](docs/plugin-author/index.md)
- [SDK package README](frontend/sdk/README.md) and [SDK API manual](https://eralde.github.io/mndw/api/sdk)

## License

MIT. See [LICENSE](LICENSE).
