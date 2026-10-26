# Plugin manifest

`manifest.json` identifies a plugin and describes the files and capabilities the host may load. The
SDK schema is authoritative: [`manifest.ts`](https://github.com/Eralde/mndw/blob/main/frontend/sdk/src/manifest.ts)
exposes its types and [`manifest-schema.ts`](https://github.com/Eralde/mndw/blob/main/frontend/sdk/src/manifest-schema.ts)
defines validation rules. Shared valid and invalid examples live in
[`frontend/sdk/fixtures/manifests`](https://github.com/Eralde/mndw/tree/main/frontend/sdk/fixtures/manifests).

## Identity and entry

Every manifest uses `manifestVersion: 1`, a lowercase `name` containing letters, digits, and hyphens,
a non-empty version and label, a `type` (`widget` or `page`), and a safe relative `entry` path. Do not
use absolute paths, `..`, backslashes, or dot segments. A widget also declares grid size: `w` is at
most 12 columns, `h` is a positive row count, and optional `minW`/`minH` cannot exceed `w`/`h`.

```json
{
  "manifestVersion": 1,
  "name": "hello-widget",
  "version": "0.1.0",
  "type": "widget",
  "label": "Hello Widget",
  "entry": "index.js",
  "size": { "w": 4, "h": 3, "minW": 2, "minH": 2 }
}
```

The `entry` points to the packaged module. For source development, the CLI resolves the source entry
from the plugin package (normally `src/index.ts`) and emits the manifest entry during packing.

## Backend routes

`backend` is optional. An `exec` backend defines request-scoped HTTP routes; each route has a unique
`id`, `transport: "http"`, a supported `method`, a safe relative `path`, and a `command` relative to
the plugin root. A `service` backend instead declares one foreground `command`, a positive
`protocolVersion`, and HTTP or WebSocket routes. Both may set `access` to `session` or `public`; it
defaults to `session`. Public HTTP routes may only use `GET` or `HEAD`.

```json
{
  "backend": {
    "kind": "exec",
    "routes": [
      {
        "id": "hello",
        "transport": "http",
        "method": "GET",
        "path": "hello",
        "command": "backend/main.sh"
      }
    ]
  }
}
```

The frontend calls the stable route id (`context.backend.fetch('hello')`), not a hard-coded daemon
URL. Route paths are canonical, relative, and cannot use the daemon-reserved `_mndw` namespace.
Route IDs and route tuples must be unique. An `exec` route always needs a command; a `service` route
does not, because the service owns its declared route table.

## Validate changes

From the repository root, validate an example with:

```bash
pnpm --filter @mndw/cli exec mndw validate ../../plugins/examples/hello-widget
```

The filter runs `mndw` from `tooling/cli`, so the path above is relative to that directory. The CLI
validates the manifest, source entry, and locale catalogs; `--strict` makes catalog parity warnings
fatal. The same manifest fixture corpus is consumed by SDK and Go validator tests, so update both
consumers when changing fixtures. Continue with the [validation and packaging guide](/guides/validation-and-packaging)
or compare the real [Hello widget manifest](https://github.com/Eralde/mndw/blob/main/plugins/examples/hello-widget/manifest.json).
