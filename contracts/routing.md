# Runtime route ownership

This document records route ownership. Paths are public protocol surface; implementation details stay
inside their owning runtime.

| Route | Production owner | Development owner | Responsibility |
| --- | --- | --- | --- |
| `/api/**` | `mndwd` | Vite proxy to `mndwd` | Management, diagnostics, palette, and plugin HTTP dispatch |
| `/api/plugins/<name>/**` | `mndwd` dispatch | `mndwd` through Vite proxy | Approved/enabled plugin backend endpoints |
| `/api/mgmt/**` | `mndwd` | `mndwd` through Vite proxy | Upload, approval, lifecycle, opkg, and management reads |
| `/api/mndw/**` | `mndwd` | `mndwd` through Vite proxy | Device access and persistent RCI-session APIs |
| `/ws/**` | `mndwd` | Vite proxy to `mndwd` | WebSocket plugin backend proxy |
| `/plugins/<name>/**` | `mndwd` static frontend | Vite plugin static middleware | Builtin plugin assets |
| `/user-plugins/<name>/**` | `mndwd` static alias | Vite plugin static middleware | Approved user-plugin assets |
| `/shared/<bundle>@<version>.js` | `mndwd` static frontend | Vite shared-bundle middleware | Host-provided shared JavaScript bundles and import-map targets |
| `/rci/**` | `mndwd` in-process device proxy | Vite device proxy | Network-device RCI API; transparent pass-through |
| `/ci/**` | `mndwd` in-process device proxy | Not proxied or exposed by Vite | Network-device CI API; transparent pass-through |
| `/auth/**` | `mndwd` in-process device proxy | Vite device proxy | Network-device authentication API and session validation upstream |

## Listener and upstream targets

Production listener and upstream facts:

- `mndwd` owns one browser-facing LAN listener for static files, device proxy,
  API, and WebSocket routes. Front-door mode is enabled by `--frontend-dir`.
- The default front-door port is `1189`. `mndwd` attempts the persisted port first,
  then the migration seed, then `1189`, followed by the remaining ports in
  `1190..1289` ascending.
- The selected port is atomically persisted in
  `/opt/var/lib/mndw/frontend-port`. During one upgrade handoff,
  `/opt/var/lib/mndw/lighttpd-port` is a migration seed and is removed after a
  successful front-door start. `lighttpd-port-policy` is retired.
- `--frontend-listen` defaults to `0.0.0.0`, intentionally binding IPv4 only
  for parity with the former device listener. IPv6 serving is out of scope.
- `S70mndwd` discovers the network device's HTTP `/auth` listener from local TCP
  listeners and its `WWW-Authenticate: x-ndw2-interactive` /
  `x-ndw4-interactive` challenge; it passes the matching URL to mndwd for
  session validation and device proxying.
- `MNDW_DEVICE_PORT` in `/opt/etc/mndw.conf` overrides discovery when a device
  exposes multiple matching listeners. Discovery fails closed when no matching
  listener or more than one matching listener is found.
- Standalone mndwd's device session-validation upstream still defaults to
  `http://127.0.0.1:80`; the package init script supplies the discovered device URL.

The mndw package no longer depends on or configures lighttpd. On upgrade,
`postinst` removes stale mndw-owned lighttpd runtime artifacts, prints the
one-time removal notice only for the old `mndw` ownership marker, and starts
the new front door. A failed restart retains `lighttpd-port` for retry.

Development proxy targets are configured by `frontend/host/vite.config.ts`:
`/api` and `/ws` use `MNDW_DAEMON` (default `http://127.0.0.1:9090`), while
`/rci` and `/auth` use `MNDW_HOST_DEVICE`. Set `MNDW_HOST_DEVICE` to a full
device URL, for example `http://192.168.1.1`, not a bare IP address.

Ownership rules:

- `mndwd` owns every production browser-facing route, including static files,
  device proxy, `/api`, and `/ws`; it does not define plugin capability state
  outside its manifest-derived registry.
- The host owns browser loading and development proxies; it does not become an
  authority for daemon state.
- Plugin packages own their declared backend payloads and static assets, not
  generic route or approval policy.
- Shared bundle URLs use `/shared/<bundle>@<version>.js`; the bundle and version
  table comes from `frontend/sdk-internal/src/shared-dependencies.ts` and is mirrored to
  `contracts/protocol/shared-deps.json`.
