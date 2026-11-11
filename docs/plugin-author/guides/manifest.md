# Plugin manifest

`manifest.json` identifies a plugin and describes the files and capabilities the host may load. The
SDK package includes `manifest.schema.json`; point editors to the installed copy so they validate
the same schema used by the CLI:

```json
{
  "$schema": "./node_modules/@mndw/sdk/manifest.schema.json"
}
```

Since manifest spec 1.7, unknown top-level keys are ignored by the runtime schema, and
`mndw validate` warns about them so a misspelled key is visible. See the shared valid and invalid
examples in [`frontend/sdk/fixtures/manifests`](https://github.com/Eralde/mndw/tree/master/frontend/sdk/fixtures/manifests).

## Identity and entry

Every manifest uses `manifestVersion: 1`, a lowercase `name` containing letters, digits, and hyphens,
a non-empty version and label, a `type` (`widget` or `page`), and a safe relative `entry` path. Do not
use absolute paths, `..`, backslashes, or dot segments. A widget also declares grid size: `w` is at
most 12 columns, `h` is a positive row count, and optional `minW`/`minH` cannot exceed `w`/`h`.

```json
{
  "$schema": "./node_modules/@mndw/sdk/manifest.schema.json",
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
from the plugin package (normally `src/index.ts`) and emits the manifest entry during packing. Page `route` is a
single segment; `/`, `/login`, `/packages`, `/packages/services`, and `/settings` are reserved host routes and are
rejected by SDK validation and host routing.

## Backend routes

`backend` is optional. An `exec` backend defines request-scoped HTTP routes; each route has a unique
`id`, `transport: "http"`, a supported `method`, a safe relative `path`, and a `command` relative to
the plugin root. Every backend command must start with `backend/`, such as `backend/main.sh`. A
`service` backend instead declares one foreground `command`, a positive
`protocolVersion`, and HTTP or WebSocket routes. Both may set `access` to `session` or `public`; it
defaults to `session`. Public HTTP routes may only use `GET` or `HEAD`.

The daemon runs files under `backend/`; it does not serve that directory as browser assets.

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

Run the public CLI from the plugins project, passing the plugin folder:

```bash
npx mndw validate hello-widget
```

The CLI validates the manifest, source entry, and locale catalogs; `--strict` makes catalog parity
warnings fatal. Continue with the [validation and packaging guide](/guides/validation-and-packaging)
or compare the real [Hello widget manifest](https://github.com/Eralde/mndw/blob/master/plugins/examples/hello-widget/manifest.json).
