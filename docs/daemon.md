# `mndwd` daemon

`mndwd` is the device-side control plane and backend execution service. It
replaces v1 CGI/sh routing and the separate prebuilt WebSocket gateway with one
Go daemon.

## Runtime topology

On the device, lighttpd keeps static hosting and proxies dynamic traffic:

```text
lighttpd :99
  ├─ /                    static host SPA and plugin assets
  ├─ /rci, /ci, /auth    router at :80
  └─ /api, /ws           mndwd at 127.0.0.1:9090

mndwd
  ├─ /api/mgmt/*         session-gated management
  ├─ /api/plugins/*      declared script endpoints
  ├─ /ws/plugins/*       declared WebSocket proxies
  └─ state.json          durable state and audit trail
```

Management and plugin namespaces are separate. Management owns
`/api/mgmt/*`; dispatch owns `/api/plugins/*`. This removes v1 rewrite-order
hazards.

In development, `mndwd --dev` runs on the developer machine. Its control plane
is the same Go code as the device. Shell scripts run under the local shell,
and `--opkg stub` simulates package operations.

## State

The daemon stores one `state.json` under its data directory. Each user plugin
records source, version, approval, enabled state, capabilities, install time,
and audit events. State changes use a mutex and atomic temporary-file rename.

Routes are derived from installed manifests and live state. There is no
separate HTTP or WebSocket index that can drift away from the manifest.

Built-in plugins are scanned from the built-in directory. User plugins are
resolved from state and revalidated before they become routable.

## Upload and approval

The management flow is deliberately staged:

```text
POST /api/mgmt/upload
  → size and zip checks
  → manifest validation
  → staging/<name>/
  → pending capability summary

POST /api/mgmt/approve
  → install opkg dependencies
  → move staging into user plugins
  → make declared scripts executable
  → start daemon hook when declared
  → mark approved and enabled
```

`deny` removes staging. A plugin with no backend can be installed directly,
because approval exists to review executable capabilities. `enable`,
`disable`, `delete`, `list`, and `pending` complete the plugin management API.

The daemon also exposes session-gated opkg management under
`/api/mgmt/opkg/*`.

## HTTP dispatch

An endpoint is resolved by plugin name, relative path, and HTTP method. The
daemon starts the declared script with:

- `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, and `CONTENT_LENGTH`;
- `MNDW_PLUGIN_ID` and `MNDW_ENDPOINT_ID`;
- request body on standard input;
- plugin directory as the working directory.

Script output follows a CGI-like contract. `Status:` and response headers may
precede a blank line; otherwise output is treated as a normal response body.
Non-zero exit and timeout become structured daemon errors.

Safety limits include request-body size, execution timeout, and a per-plugin
concurrency cap. Stderr is logged; development responses may include a short
stderr tail, while production responses stay terse.

## WebSocket proxy

The daemon resolves a declared WebSocket path to its local target, normalizes
the target scheme, and dials the backend before upgrading the client. It
forwards messages in both directions and applies a read limit.

If the manifest declares protocols, the client and declaration must intersect.
An absent declaration means no protocol restriction. Approval, enabled state,
and the public/session rule still apply.

## Authentication and authorization

Management routes require a valid router session. The daemon replays the
request cookie against the router's `/auth` endpoint and caches positive and
short-lived negative results. Transport failure fails closed.

Plugin routes also require a session unless the plugin explicitly sets
`backend.public: true`. Public access skips only the cookie check; it never
skips approval or enabled-state checks. `--dev` bypasses session validation and
logs that the bypass is active.

Unauthenticated dispatch is gated before route matching for private plugins.
This prevents path probes from revealing whether a private route exists.

## Errors and logging

Every non-success API response uses one envelope:

```json
{
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "route was not found",
    "detail": null
  }
}
```

Codes are stable machine keys. The SDK maps relevant codes to typed client
errors. Request logs include method, path, status, duration, and plugin name;
request bodies are never logged. Security-sensitive changes also enter the
durable audit trail.

## Lifecycle and opkg

`backend.daemon.start` and `.stop` hooks run on approval, enable, disable,
startup, and shutdown as appropriate. The daemon is process-stateless: the
hook owns backgrounding and any pidfile, which lets a process survive a daemon
restart when designed to do so.

Opkg operations have an executable mode for devices and a stub mode for local
development and tests. Dependency installation happens before an approved
plugin leaves staging, so a package failure leaves a retryable pending plugin.

