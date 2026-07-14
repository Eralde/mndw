# mndw

Modular plugin-based web dashboard for Keenetic network devices.

## Quick Start

Prerequisites: Node 22+, pnpm 10+, Go 1.26+.

```bash
git clone <repo-url>
pnpm install
pnpm dev
```

Host SPA opens at `http://localhost:5173`, proxying `/api`/`/ws` to a local `mndwd --dev` daemon
and `/rci`/`/auth` to a real Keenetic device (set `MNDW_HOST_DEVICE` env var).
In production lighttpd also proxies `/ci`; the Vite dev proxy does not yet include `/ci`
(that is a host-level change, not packaging).

## Plugin Authoring

```bash
mndw create my-widget --framework svelte --type widget
mndw dev my-widget
mndw zip my-widget
```

See [SDK plugin-author guide](packages/sdk/README.md).

## IPK Build

```bash
pnpm build-ipk --arch mipsel-3.4
pnpm build-ipk --all
pnpm build-ipk --all --repo
```

Output: `out/mndw_<version>_<arch>.ipk`. Requires Go cross-compile toolchain.

## Architecture

```text
lighttpd :99
  ├── /                          static SPA
  ├── /rci, /ci, /auth           proxy → router br0 :80
  ├── /api/*, /ws/*              proxy → mndwd 127.0.0.1:9090
```

## Project Layout

```text
packages/   sdk/ host/ cli/ daemon/
example-plugins/
deploy/     lighttpd, init, ipk scripts, install.sh
tools/      palette, build-ipk, dev supervisor
docs/
```

## Links

- [SDK plugin-author guide](packages/sdk/README.md)
- [Design doc](docs/rewrite/02-v2-design.md)
- [Implementation plan](docs/rewrite/03-implementation-plan.md)
