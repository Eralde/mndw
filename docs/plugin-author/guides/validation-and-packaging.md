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

The `@mndw/sdk` version is the context contract version (`PluginContext`). Minor releases add context
capabilities; major releases can change the contract. `mndw pack` records the exact SDK and shared
dependency versions used to build the plugin in `mndw.lock.json`.

During approval, the install screen warns if the plugin was built for a newer SDK or a different
major version of a host-shared dependency. The warning explains the compatibility risk, but installing
is still allowed. A plugin built against an older SDK minor version installs silently.

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
