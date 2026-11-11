# `mndwd` daemon

`mndwd` is device control plane and backend execution service. It exposes one
manifest gateway for request-scoped `exec` commands and supervised
foreground `service` processes.

## Runtime topology

```text
browser
  └─ mndwd
      ├─ static host SPA and plugin assets
      ├─ rci/ and auth/ proxy
      └─ API and WebSocket gateway

mndwd
  ├─ session-gated management
  ├─ declared HTTP and WebSocket routes
  └─ state.json          durable state and audit trail
```

The gateway resolves plugin, route id, transport, method, access, approval,
and enabled state from one manifest-derived registry. Service sockets, command
paths, process ids, args, and package requirements never enter host descriptors.
Request routing, listener ports, and upstream targets are owned by
[`contracts/routing.md`](../contracts/routing.md).

## Upload and approval

```text
POST /api/mgmt/upload
  → size and zip checks
  → manifest validation and static command checks
  → staging/<name>/ (non-executable)
  → pending capability summary

POST /api/mgmt/approve
  → explicit package installation
  → move staging into user plugins
  → make declared commands executable
  → mark approved and enabled
```

Service activation is owned by `backend.Runtime`; startup reconciles approved
and enabled services without background package-install retries. `enable`,
`disable`, `delete`, `restart`, `list`, and `pending` complete management.

### Plugin file layout

An installed plugin is one tree under the user plugins directory: frontend
assets, `backend/` commands, and update backups (`<name>.previous-<version>`)
live side by side. `/user-plugins/` serves that tree only to authenticated
sessions and filters what it exposes: plugin names must match the manifest
name pattern, the `backend/` segment and backups are never served, and checks
apply to symlink-resolved paths. The manifest contract keeps every backend
command under `backend/`. Package contents are still not a place for secrets.

## Exec backends

Exec routes accept HTTP only. The daemon buffers request bodies before spawn,
enforces size and global/per-plugin admission limits, starts the declared file
directly in a new process group, and reaps the whole group on timeout or
cancellation. It supplies bounded CGI metadata including `REQUEST_METHOD`,
`QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `MNDW_PLUGIN_ID`, and
`MNDW_ROUTE_ID`; cookies, authorization, CSRF values, and arbitrary daemon
environment are not forwarded.

CGI output is parsed before response commit. Forbidden hop-by-hop, CORS,
proxy-credential, `Set-Cookie`, and `Content-Length` headers are removed,
output/stderr are bounded, and responses use `Cache-Control: no-store`.

## Live backend status

`GET /api/plugins/{name}/_mndw/status` is a session-authenticated,
`Cache-Control: no-store` status route. Authentication happens before plugin
resolution; unknown and backendless names return `404` only after
authentication. The specific route is separate from generic plugin path
canonicalization, so an ordinary manifest route named `status` remains valid.

Projection precedence is `not-approved`, `disabled`, `maintenance`; approval
precedes the enabled flag, so a persisted pending backend reports `not-approved`
even though upload also stores it as disabled. Exec then returns `ready`; service
backends continue through static protocol `incompatible`, structured activation
`blocked`, and supervisor runtime projection. Activation blockers apply only to
services because activation gates control service scheduling; exec request
admission has no equivalent gate.

Service `starting` and `backoff` map to `starting`, with a future
`NextAttemptAt` rounded up to whole seconds. Missing, equal, or expired
timestamps map to `retryAfterSeconds: null`. `capacity_blocked` maps to
`starting` with no retry hint; stopped, failed, or missing runtime maps to
`unavailable`.

Compatibility uses manifest `protocolVersion` and the daemon's configured
supported protocol list, independent of supervisor diagnostic compatibility
fields. Responses contain only `kind`, `state`, `retryAfterSeconds`, blocker
tuples, or incompatible protocol fields. They never contain errors, stderr,
restart counters, process data, socket paths, credentials, or tokens.

SDK plugin-name binding is ergonomic scoping, not an authorization identity.
Any authenticated device session may query a known plugin name; there is no
enumeration endpoint. This disclosure matches the existing authenticated
device-session trust tier.

## Service backends

Plugin authors should use the [service backend guide](service-backend.md) for
the child-facing contract. This page covers daemon-owned supervision and
security behavior.

Each service is a foreground child speaking HTTP/1.1 and optional WebSocket on
`backend.sock` under `/opt/tmp/mndw/plugin-runtime/<plugin-id>`. The daemon
owns readiness (`GET /_mndw/ready`), protocol compatibility, Unix-socket
proxying, leases, process groups, restart backoff, and shutdown. Service
children receive `MNDW_BACKEND_SOCKET`, `MNDW_BACKEND_PROTOCOL`,
`MNDW_PLUGIN_DATA_DIR`, and an allowlisted environment.

Runtime states are `stopped`, `capacity_blocked`, `starting`, `ready`,
`backoff`, and `failed`. Limits default to 8 total exec requests, 4 per
plugin, and 8 supervised services. Service HTTP timeout is 30s; drain is 35s;
service stop is `service-stop-timeout` (default 15s); final reap is 2s.
Unsupported protocols remain enabled in state but never start
and report `BACKEND_INCOMPATIBLE`.

## Authentication and authorization

Management routes require a valid device session, and unsafe management
mutations also require the fixed `X-Mndw-Csrf: 1` header. Private plugin routes
also require session access; public route access is per-route and only GET/HEAD
HTTP routes may be public. Public access never bypasses approval or enabled
checks. `--dev` bypasses session validation but does not bypass CSRF on unsafe
management mutations.

WebSocket Origin is checked at the gateway. No CORS headers are emitted, and
the fixed `X-Mndw-Csrf: 1` header is required for unsafe private HTTP and
management calls.
Maintenance closes sockets with WebSocket close code `1012` and reason
`mndw updating`; clients show explicit reconnect UX and do not silently resume.

## Diagnostics, state, and trust

Diagnostics export combines daemon-owned state with optional ready-service
`GET /_mndw/diagnostics` JSON. Responses are short-timeout, bounded per plugin
and in aggregate, recursively redacted, and independent per service; no
filesystem diagnostics file is required. Commands, args, sockets, PIDs,
credentials, cookies, and child environments stay out of reports. Durable
state stays under `/opt/var/lib/mndw`; runtime sockets, leases, and disposable
state stay under `/opt/tmp/mndw/plugin-runtime` with mode `0700`.

Approved exec commands and service children run with daemon/device privileges
by design. Approval is therefore the root-equivalent code-execution boundary.
