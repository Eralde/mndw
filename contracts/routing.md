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

- lighttpd snapshots live TCP listeners before stopping shared lighttpd, scans standard top-level
  `/opt/etc/lighttpd/conf.d/*.conf` claims plus mndw's runtime ownership, and normalizes that evidence;
- when no persisted mndw port exists, unannotated `lighttpd -p` output supplements source evidence; its failure is
  nonfatal after successful source scanning;
- after evidence collection, lighttpd stops shared lighttpd and selects the first browser-usable port in `99..199`
  absent from foreign/configured/live evidence, except a persisted port proven live and claimed by mndw with no
  foreign claim; browser-blocked ports in that range include `101`, `102`, `103`, `104`, `109`, `110`, `111`, `113`,
  `115`, `117`, `119`, `123`, `135`, `137`, `139`, `143`, `161`, and `179`;
- selected port is persisted in `/opt/var/lib/mndw/lighttpd-port`;
- `mndwd` listens on `127.0.0.1:9090` by default;
- `S70mndwd` discovers the router's HTTP `/auth` listener from local TCP listeners and its
  `WWW-Authenticate: x-ndw2-interactive` / `x-ndw4-interactive` challenge; it writes the matching
  router IP and port into `proxy-target.conf` and passes the same URL to mndwd for session validation.
- `MNDW_ROUTER_PORT` in `/opt/etc/mndw.conf` overrides discovery when a device exposes multiple matching
  listeners. Discovery fails closed when no matching listener or more than one matching listener is found.
- Standalone mndwd's router session-validation upstream still defaults to `http://127.0.0.1:80`; the package
  init script supplies the discovered device URL.

Foreign configuration claims survive shared-service stop. web4static-style `server.port := 99` and
`$SERVER["socket"] == ":99"` therefore reserve port 99. Missing `conf.d` is valid empty evidence. A present but
unreadable config directory, unreadable top-level config, or unreadable mndw runtime config aborts before lighttpd is
stopped. The source scanner intentionally covers literal claims in top-level `conf.d/*.conf` only; it does not recurse
or evaluate variables, expressions, or nested includes. Overlapping same-process socket blocks may fail config parsing
through duplicate conditional assignments rather than emit `Address already in use`; foreground probe and daemon
handoff remain final race checks.

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
