# Plugin anatomy

A plugin combines a manifest, a frontend entry, and optionally a backend. The scaffold gives each part a place in a
regular Node.js project.

## What a plugin contains

The [`manifest.json`](/guides/manifest) identifies the plugin, selects `widget` or `page`, points to its entry, and
declares permissions and any backend commands. The frontend entry exports `createInstance(container, ctx)`. The host
calls it with a DOM container and `PluginContext`; it returns a `PluginInstance` with `unmount()` and optional
`onResize()` for widgets. See the [frontend lifecycle guide](/guides/frontend-lifecycle).

A backend is optional. Shell and Go backends expose declared routes through the typed `ctx.backend` client; device
management calls use `ctx.rciManager` through the host. Read the [shell backend guide](/guides/shell-backend) and
[RCI API guide](/guides/rci-api) for those boundaries.
Backend commands must use relative paths under `backend/`, and the daemon does not serve files in that directory as
browser assets.

## What the host provides

`PluginContext` is passed to `createInstance` and exposes host services:

- `rciManager` queues device operations; `backend` is present when the manifest declares a backend. See the
  [RCI API guide](/guides/rci-api) and [shell backend guide](/guides/shell-backend).
- `storage` and `sharedStorage` store plugin data; `deviceInfo` provides a device snapshot.
- `theme`, `locale`, and `palette` provide current values and observable updates through `theme$`, `locale$`, and
  `palette$`; `i18n` provides localized messages. See the [frontend lifecycle guide](/guides/frontend-lifecycle).
- `telemetry` fetches projected data; `events` is optional and appears when the manifest declares event permissions.
- `overlay` presents modals and drawers, and `createTicker()` creates a host-managed ticker.
- `pageRoute` provides navigation within page plugins; `setTileTitle` sets a widget's host tile title.

The SDK reference documents the complete [`PluginContext`](/api/sdk#plugincontext) contract.

## A plugin's path

Edit the source and manifest, run `mndw pack` to build frontend assets and stage runtime files in `dist/`, then run
`mndw zip` to create the upload archive. Upload the ZIP through the dashboard's plugin management flow. A plugin with
a backend requires approval before it can run; a plugin without one installs directly. The [validation and packaging
guide](/guides/validation-and-packaging) covers the archive, and [install mndw](/install) covers the dashboard setup.
On the router, `mndwd` serves plugin files and runs or proxies the declared backend.

## Scaffold tree

This is the `hello-widget` scaffold with a shell backend:

<!-- docs-check: scaffold hello-widget --type widget --framework svelte --backend sh -->
```text
hello-widget/
  backend/
    main.sh
  i18n/
    en.json
    ru.json
  manifest.json
  package.json
  src/
    App.svelte
    TableNameCell.svelte
    index.ts
    l10n.test.ts
    table.test.ts
  vitest.config.ts
```

- `backend/main.sh` handles the scaffold's shell route.
- `i18n/en.json` and `i18n/ru.json` hold the English and Russian catalogs.
- `manifest.json` declares the plugin identity, entry, and backend route.
- `package.json` is the plugin npm package manifest; it lists `@mndw/sdk`, `@mndw/ui`, the framework wrapper such as
  `@mndw/ui-svelte`, and the build and test tools.
- `src/App.svelte` implements the widget view.
- `src/TableNameCell.svelte` renders a table cell used by the scaffold.
- `src/index.ts` exports the frontend plugin entry.
- `src/l10n.test.ts` and `src/table.test.ts` cover the generated view and table cell.
- `vitest.config.ts` configures the scaffold's test runner.


## Example plugins

Built-in plugins in `plugins/builtin/` include `device-info-widget`, `cpu-temp-widget`, `tx-rx-chart-widget`,
`terminal-page`, `clock-widget`, `dns-lookup-widget`, `mws-page`, `clients-widget`, and `system-log-page`.
Uploadable examples in `plugins/examples/` include `backend-echo`, `demo-page`, `device-traffic-widget`, and
`ping-widget`.
