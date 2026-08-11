# Plugin author guide

This guide covers the smallest useful v3 plugin and the checks it should pass.
Use the CLI for scaffolding and packaging so generated files match the host and
daemon contracts.

## Create a project

```bash
mndw create hello --type widget --framework svelte --backend sh
cd hello
mndw dev .
```

For a page, use `--type page` and choose a route that is not reserved. For a
vanilla plugin, use `--framework vanilla`. Vue and Angular use the same
manifest and lifecycle contracts but add framework-specific shared bundles.

The generated project has this shape:

```text
hello/
  manifest.json
  src/index.ts
  src/App.svelte       Svelte projects only
  src/index.css
  backend/main.sh      when --backend sh is selected
```

Plugins may keep development-only behavior in `src/index.ts`, which `mndw dev`
loads. To select a different production source, add this build-only setting to
`package.json`:

```json
"mndw": {"productionEntry": "src/index.prod.ts"}
```

`mndw pack` bundles only configured production source; manifest entry and output
filename stay unchanged. Configured file must be regular `.ts` below `src/`,
and `src/index.ts` must still exist because `mndw validate` requires it and
`mndw dev` loads it by path.

Repository `pnpm dev` builds built-in plugins from `src/index.ts`, while
`pnpm build-builtin-plugins` uses configured production entries.

## Implement the module

The entry exports `createInstance`. Mount UI into the supplied container and
return an instance with cleanup:

```ts
export const createInstance = (
  container: HTMLElement,
  context: PluginContext,
): PluginInstance => {
  container.textContent = `Hello ${context.hostInfo.deviceName}`

  return {
    unmount: () => {
      container.replaceChildren()
    },
  }
}
```

Use `onResize({w, h})` when layout changes affect rendering. `w` and `h` are
grid units, not pixels. A widget's preferred and minimum dimensions belong in
the manifest's `size` object.

## Manifest rules

Names are lowercase path-safe segments. Entry and backend source paths are
relative and cannot contain traversal or backslashes. Page routes are one
segment and cannot use `/`, `/login`, or `/settings`.

An exec backend declares commands directly on HTTP routes:

```json
{
  "manifestVersion": 3,
  "backend": {
    "kind": "exec",
    "routes": [{
      "id": "hello",
      "transport": "http",
      "method": "GET",
      "path": "hello",
      "command": "backend/main.sh"
    }]
  }
}
```

The path is `hello`, not `/api/plugins/hello/hello`. `mndwd` supplies the
plugin namespace.

## Implement a service backend

For a resident HTTP/WebSocket backend, follow the [service backend
guide](service-backend.md). It covers the manifest, Unix-socket/readiness
contract, lifecycle, security boundary, and tested Go reference.

## Call a backend

Use the declared id, not a URL assembled by hand:

```ts
const response = await context.backend?.fetch('hello')
const text = await response?.text()
```

For WebSockets, use `context.backend.socket('terminal')`. The SDK reports
unknown, unapproved, and disabled capabilities as typed errors. Handle these
errors in UI copy rather than depending on daemon URL details.

## Write a shell endpoint

A shell script receives request metadata through environment variables and a
request body on standard input. It writes a CGI-like response:

```sh
#!/bin/sh

printf 'Status: 200 OK\r\n'
printf 'Content-Type: text/plain\r\n'
printf '\r\n'
printf 'hello from %s\n' "$MNDW_PLUGIN_ID"
```

Declare every executable command in the manifest. `mndw pack` copies declared
commands with mode `0755`, rejects missing files, and includes them in archive.

## Use host services

Prefer SDK and context surfaces:

- `storage` for state belonging to one widget instance;
- `sharedStorage` for state shared by instances of one plugin;
- `rciManager` for device communication;
- `hostInfo` for device identity and theme;
- `overlay` for modal, drawer, popover, or custom top-layer UI. At viewport widths
  `<=600px`, host-presented modals and drawers become full-width, content-sized
  bottom sheets; their explicit `width` and `height` options are overridden, and
  the choice is made when the overlay opens;
- `onThemeChange` for theme-sensitive rendering;
- `injector` for approved host service tokens.

Do not attach global overlays, global event listeners, or document-level focus
management without cleanup. The host owns the top layer and calls `unmount`.

## Style consistently

Use generated `--mndw-*` design tokens from the SDK. The host supports light
and dark themes, and every example plugin should remain legible in both. Keep
plugin CSS scoped to the plugin root where possible.

## Validate and package

Run the full author loop before upload:

```bash
mndw validate .
mndw pack .
mndw zip .
```

Check that the archive contains `manifest.json` at its root, the entry output,
optional `index.css`, `mndw.lock.json`, and all declared backend assets.

Backend plugins show packages, route methods/transports/access, and service
protocol during approval. Treat approval as a security review: approved exec
commands and service children execute with device daemon privileges.
