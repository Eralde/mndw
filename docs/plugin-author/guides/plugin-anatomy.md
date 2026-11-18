# Plugin anatomy

A plugin combines a manifest, a frontend entry, and optionally a backend. The scaffold gives each part a place in a
regular Node.js project.

## What a plugin contains

The [`manifest.json`](/guides/manifest) identifies the plugin, selects `widget` or `page`, points to its entry, lists
requested capabilities, and declares any backend commands. Capabilities do not sandbox plugin code; see the
[manifest trust guidance](/guides/manifest#capabilities-and-trust). The frontend entry exports
`createInstance(container, ctx)`. The host calls it with a DOM container and `PluginContext`; it returns a
`PluginInstance` with `unmount()` and optional
`onResize()` for widgets. See the [frontend lifecycle guide](/guides/frontend-lifecycle).

A backend is optional. Shell and Go backends expose declared routes through the typed `ctx.backend` client; device
management calls use `ctx.device.rci` through the host. Read the [shell backend guide](/guides/shell-backend) and
[RCI API guide](/guides/rci-api) for those boundaries.
Backend commands must use relative paths under `backend/`, and the daemon does not serve files in that directory as
browser assets.

## What the host provides

`PluginContext` is passed to `createInstance` and exposes host services:

- `device.rci` queues device operations and `device.info` provides a device snapshot; `backend` is present when the manifest declares a backend. See the
  [RCI API guide](/guides/rci-api) and [shell backend guide](/guides/shell-backend).
- `storage.instance` and `storage.shared` store plugin data. `appearance.theme` and `appearance.palette` provide
  current values and observable updates through `appearance.theme$` and `appearance.palette$`; `i18n.locale$` emits
  the active locale after its catalog is applied. See the [frontend lifecycle guide](/guides/frontend-lifecycle).
- `telemetry` fetches projected data; `events` is optional and appears when the manifest declares event capabilities.
- `overlay` presents modals and drawers, and `timers.createTicker()` creates a host-managed ticker.
- `pageRoute` provides navigation within page plugins. The host draws each widget's tile title; use `setTileTitle`
  (`ctx.setTileTitle?.(ctx.i18n.t('title'))`) to set its translated value on mount and when the locale changes. Do not
  draw a second widget title inside the plugin. Pages should keep their own visible `<h2>` heading.

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
    index.ts
    l10n.test.ts
  svelte.config.js
  vitest.config.ts
```

- `backend/main.sh` handles the scaffold's shell route.
- `i18n/en.json` and `i18n/ru.json` hold the English and Russian catalogs.
- `manifest.json` declares the plugin identity, entry, and backend route.
- `package.json` is the plugin npm package manifest; it lists `@mndw/sdk`, `@mndw/ui`, the framework wrapper such as
  `@mndw/ui-svelte`, and the build and test tools.
- `src/App.svelte` implements the widget view.
- `src/index.ts` exports the frontend plugin entry.
- `src/l10n.test.ts` checks that the generated view updates when the locale changes.
- `svelte.config.js` configures the Svelte compiler.
- `vitest.config.ts` configures the scaffold's test runner.


## Example plugins

Built-in plugins in `plugins/builtin/` include `device-info-widget`, `cpu-temp-widget`, `tx-rx-chart-widget`,
`terminal-page`, `clock-widget`, `dns-lookup-widget`, `mws-page`, `clients-widget`, and `system-log-page`.
Uploadable examples in `plugins/examples/` include `backend-echo`, `demo-page`, `device-traffic-widget`, and
`ping-widget`.
