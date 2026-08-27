# Host application

The host is the Svelte 5 SPA that users see in the browser.
It is responsible for presentation and plugin runtime concerns.
It does not execute plugin backend commands or decide whether a backend is approved.

## Boundary

Request routing, listener ports, and upstream targets are owned by
[`contracts/routing.md`](../contracts/routing.md).

In development, Vite uses `MNDW_HOST_DEVICE` and `MNDW_DAEMON` to select its
upstream targets.

## Startup

The startup sequence is:

1. initialize theme and session services;
2. check router authentication;
3. fetch host information, with a safe fallback on failure;
4. fetch `GET /api/mgmt/list` and load enabled plugin modules;
5. create routes and render the app shell.

The login page is a host state, not a normal plugin route. Authentication
errors return the user to that state. Window-level error guards identify plugin
errors so a broken plugin does not take down the host.

## Routing and dashboard

Static routes are `/`, `/packages`, and `/settings`. Enabled page plugins
contribute routes with one path segment. Widget plugins never become routes.

The default dashboard uses GridStack with twelve columns. A tile contains a
host-owned frame and a plugin-owned content element. The frame supplies title,
remove control, resize behavior, and an error state.

Dashboard behavior includes:

- multiple instances of one widget;
- grid-unit size and minimum-size constraints from the manifest;
- add, remove, resize, and layout persistence in localStorage;
- `onResize({w, h})` callbacks in grid units;
- restoration of instance counters and tile geometry.

The old dockview `/workspace` dashboard and pixel-to-grid conversion are not
part of the current dashboard.

## Plugin runtime

The runtime pipeline is intentionally linear:

```text
daemon list
  → loader
  → registry
  → lifecycle
  → context
  → widget tile or page host
```

The loader imports each plugin's entry module and optional `index.css`. It
deduplicates names and page routes as a defense-in-depth check. One failed
plugin is logged and skipped; other plugins continue to load.

The lifecycle owns instance creation, unmount, overlay cleanup, storage
scoping, and error isolation. The registry stores loaded modules and provides
widget/page queries to the dashboard and router.

## Context and host services

Each plugin instance receives a context containing:

- the RCI manager shared by the host;
- per-instance `storage` and per-plugin `sharedStorage`;
- device name, vendor, firmware, and theme in `hostInfo`;
- host service lookup through `injector`;
- a unique `instanceId`;
- theme-change subscription;
- the framework-neutral overlay service;
- an optional typed backend client.

The host owns overlay stacking, escape and outside dismissal, scroll locking,
and cleanup. A plugin supplies content; it does not own the top layer or
global focus behavior.

## Theme and settings

The palette tool generates light and dark design tokens. The host imports the
generated `tokens.css`, applies the active theme, and exposes typed token names
through the SDK. Plugins should use `--mndw-*` custom properties instead of
inventing a separate visual system.

The settings area contains appearance and device controls.
It also manages plugin upload, approval, enable/disable, and delete operations.

## Development sandbox

`mndw dev <plugin>` runs a source plugin through a Vite virtual module and a
local `mndwd --dev` instance. The host can reload the plugin transactionally:

1. validate the new module and manifest;
2. replace the registry record;
3. remount widgets or the active page;
4. roll back registry and mounts if any step fails.

A type or route topology change requires restart. Normal host startup remains
daemon-list based.
