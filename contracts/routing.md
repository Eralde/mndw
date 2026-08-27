# Runtime route ownership

This document records route ownership. Paths are public protocol surface; implementation details stay
inside their owning runtime.

| Route | Production owner | Development owner | Responsibility |
| --- | --- | --- | --- |
| `/api/**` | `mndwd` through lighttpd proxy | Vite proxy to `mndwd` | Management, diagnostics, palette, and plugin HTTP dispatch |
| `/api/plugins/<name>/**` | `mndwd` dispatch | `mndwd` through Vite proxy | Approved/enabled plugin backend endpoints |
| `/api/mgmt/**` | `mndwd` | `mndwd` through Vite proxy | Upload, approval, lifecycle, opkg, and management reads |
| `/api/mndw/**` | `mndwd` | `mndwd` through Vite proxy | Device access and persistent RCI-session APIs |
| `/ws/**` | `mndwd` through lighttpd proxy | Vite proxy to `mndwd` | WebSocket plugin backend proxy |
| `/plugins/<name>/**` | lighttpd document root | Vite plugin static middleware | Builtin plugin assets |
| `/user-plugins/<name>/**` | lighttpd alias | Vite plugin static middleware | Approved user-plugin assets |
| `/shared/<bundle>@<version>.js` | lighttpd document root | Vite shared-bundle middleware | Host-provided shared JavaScript bundles and import-map targets |
| `/rci/**` | router proxy selected by lighttpd | Vite device proxy | Router RCI API; not owned by `mndwd` |
| `/ci/**` | router proxy selected by lighttpd | Not proxied or exposed by Vite | Router CI API; not owned by `mndwd` |
| `/auth/**` | router proxy selected by lighttpd | Vite device proxy | Router authentication API; `mndwd` calls `/auth` for session validation |

## Listener and upstream targets

Production listener and upstream facts:

- lighttpd selects or reuses the first free mndw dashboard port in `99..199` and persists it in
  `/opt/var/lib/mndw/lighttpd-port`;
- `mndwd` listens on `127.0.0.1:9090` by default;
- mndwd's router session-validation upstream defaults to `http://127.0.0.1:80`.

Development proxy targets are configured by `frontend/host/vite.config.ts`: `/api` and `/ws` use
`MNDW_DAEMON` (default `http://127.0.0.1:9090`), while `/rci` and `/auth` use
`MNDW_HOST_DEVICE`. Set `MNDW_HOST_DEVICE` to a full device URL, for example
`http://192.168.1.1`, not a bare IP address.

Ownership rules:

- lighttpd owns production routing and static-file exposure; it does not define plugin capability state.
- `mndwd` owns `/api` and `/ws` behavior, including approval, enabled state, session gates, and structured errors.
- The host owns browser loading and development proxies; it does not become an authority for daemon state.
- Plugin packages own their declared backend payloads and static assets, not generic route or approval policy.
- Shared bundle URLs use `/shared/<bundle>@<version>.js`; the bundle and version table comes from
  `frontend/sdk/shared-dependencies.ts` and is mirrored to `contracts/protocol/shared-deps.json`.
