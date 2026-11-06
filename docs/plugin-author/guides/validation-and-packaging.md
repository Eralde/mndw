# Validation and packaging

Use three CLI commands for the source-to-upload flow:

| Command | What it does | Default output |
| --- | --- | --- |
| `mndw validate <plugin-dir>` | Checks manifest, source entry, and locale catalogs. | No generated output. |
| `mndw pack <plugin-dir>` | Builds the frontend and stages declared runtime files. | `<plugin-dir>/dist/` |
| `mndw zip <plugin-dir>` | Packs, then creates an upload archive. | `<plugin-dir>/<plugin-name>.zip` |

Run these commands from the plugins project, passing the plugin folder as the argument:

```bash
npx mndw validate hello-widget
npx mndw pack hello-widget
npx mndw zip hello-widget
```

`pack` emits the manifest, bundled entry, optional `index.css`, `mndw.lock.json`, artifact metadata,
and declared runtime assets in `dist/`. It does not create an upload ZIP. `zip` creates an archive
whose root contains `manifest.json`; it does not wrap the files in a `dist/` directory. Hidden files
are excluded. Both `dist/` and `*.zip` are ignored generated output in this repository; edit source
and manifest, then regenerate instead of editing generated files.

ZIP entries for backend commands declared in the manifest use mode `0755`, so the device can execute
them after installation.

## Versions and compatibility

All `@mndw/*` packages share the product version. Scaffolded plugin dependencies use a caret range based on the CLI
version that created the project; while the product is `0.x`, breaking API, manifest, or protocol changes bump the
minor version. See [package versioning](/guides/project-setup#package-versioning) for the coordinated upgrade rule.
`mndw pack` records the exact SDK and shared dependency versions used to build the plugin in `mndw.lock.json`.

During approval, the install screen warns if the plugin was built for a newer SDK or a different
major version of a host-shared dependency. The warning explains the compatibility risk, but installing
is still allowed. A plugin built against an older SDK minor version installs silently.

## Shared dependencies and D3

The CLI externalizes host-provided packages during packing. `@rci-tools/core`, `rxjs`, `rxjs/operators`, `hash-wasm`,
`d3`, and `@mndw/ui` are shared across plugins; Vue plugins also externalize `vue`, and Angular plugins externalize
`zone.js`, `@angular/core`, `@angular/common`, `@angular/platform-browser`, and `@angular/compiler`. The host supplies
versioned bundles for these imports.

The host provides the complete `d3@7.9.0` package as one shared bundle. Import its namespace and keep `d3` and
`@types/d3` in plugin `devDependencies` for local type checking and tests:

```js
import * as d3 from 'd3';
```

Official D3 APIs, including `zoom`, come from that namespace. Third-party extensions such as `d3-dag` are not host
provided and remain bundled with the plugin. Packages outside the shared-dependency list follow that same rule.

## Manual upload

Dashboard Settings is the recommended upload path. An authenticated manual request needs the persisted dashboard port
from `/opt/var/lib/mndw/frontend-port`, an active session cookie, and the CSRF header:

```sh
curl --cookie '<authenticated-session-cookie>' \
  -H 'X-Mndw-Csrf: 1' \
  --data-binary @my-widget.zip \
  http://<device>:<dashboard-port>/api/mgmt/upload
```

Each archive includes `mndw.lock.json` with exact shared dependency versions.

## Before uploading

1. Run the plugin's tests from its plugin folder, then run `mndw validate hello-widget` from the plugins project.
2. Run `mndw pack hello-widget` and inspect the output: confirm manifest/entry paths, locale files, CSS if
   expected, and every declared backend command are present.
3. Run `mndw zip hello-widget`; inspect the archive and confirm `manifest.json` is at its root, not under `dist/`.
4. Review the backend source and declared routes. Device approval runs backend code with daemon
   privileges; only upload and approve code you trust.
5. Test read-only behavior first. Exercise device writes only with an intentional, reversible test
   and a real device you are authorized to modify. Packaging tests do not prove device behavior.

Upload the generated ZIP through the device's supported plugin-management flow; installation and
approval happen on the device and are separate from local validation, packing, and archiving. For
the complete source examples, see the [Hello widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/hello-widget)
and [device-name widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/rci-device-name-widget).
Return to the [plugin anatomy guide](/guides/plugin-anatomy) for the source/output file map.
