# `mndwd` daemon

`mndwd` is device control plane and backend execution service. It exposes one
manifest-v3 gateway for request-scoped `exec` commands and supervised
foreground `service` processes.

## Runtime topology

```text
lighttpd :99
  ├─ /                    static host SPA and plugin assets
  ├─ /rci, /ci, /auth    router at :80
  └─ /api, /ws           mndwd at 127.0.0.1:9090

mndwd
  ├─ /api/mgmt/*         session-gated management
  ├─ /api/plugins/*      exec and service HTTP routes
  ├─ /ws/plugins/*       service WebSocket routes
  └─ state.json          durable state and audit trail
```

The gateway resolves plugin, route id, transport, method, access, approval,
and enabled state from one manifest-derived registry. Service sockets, command
paths, process ids, args, and package requirements never enter host descriptors.

## Upload and approval

```text
POST /api/mgmt/upload
  → size and zip checks
  → v3 manifest validation and static command checks
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

## Exec backends

Exec routes accept HTTP only. The daemon buffers request bodies before spawn,
enforces size and global/per-plugin admission limits, starts the declared file
directly in a new process group, and reaps the whole group on timeout or
cancellation. It supplies bounded CGI metadata including `REQUEST_METHOD`,
`QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `MNDW_PLUGIN_ID`, and
`MNDW_ROUTE_ID`; cookies, authorization, CSRF values, and arbitrary daemon
environment are not forwarded.

CGI output is parsed before response commit. Forbidden hop-by-hop, credential,
and CORS headers are removed, output/stderr are bounded, and responses use
`Cache-Control: no-store`.

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
service stop is 10s; final reap is 2s. Unsupported protocols remain enabled
in state but never start and report `BACKEND_INCOMPATIBLE`.

## Authentication and authorization

Management routes require a valid router session. Private plugin routes also
require it; public route access is per-route and only GET/HEAD HTTP routes may
be public. Public access never bypasses approval or enabled checks. `--dev`
bypasses session validation and logs that fact.

WebSocket Origin is checked at the gateway. No CORS headers are emitted, and
the fixed `X-Mndw-Csrf: 1` header is required for unsafe private HTTP calls.
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
