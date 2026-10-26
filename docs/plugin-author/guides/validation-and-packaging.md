# Validation and packaging

Use three CLI commands for the source-to-upload flow:

| Command | What it does | Default output |
| --- | --- | --- |
| `mndw validate <plugin-dir>` | Checks manifest, source entry, and locale catalogs. | No generated output. |
| `mndw pack <plugin-dir>` | Builds the frontend and stages declared runtime files. | `<plugin-dir>/dist/` |
| `mndw zip <plugin-dir>` | Packs, then creates an upload archive. | `<plugin-dir>/<plugin-name>.zip` |

From the repository root, `mndw` is available through `pnpm exec`. The following example commands
use the CLI package filter; filtered commands run from `tooling/cli`, so paths are relative to that
directory:

```bash
pnpm --filter @mndw/cli exec mndw validate ../../plugins/examples/hello-widget
pnpm --filter @mndw/cli exec mndw pack ../../plugins/examples/hello-widget
pnpm --filter @mndw/cli exec mndw zip ../../plugins/examples/hello-widget

pnpm --filter @mndw/cli exec mndw validate \
  ../../plugins/examples/rci-device-name-widget
pnpm --filter @mndw/cli exec mndw pack \
  ../../plugins/examples/rci-device-name-widget
pnpm --filter @mndw/cli exec mndw zip \
  ../../plugins/examples/rci-device-name-widget
```

`pack` emits the manifest, bundled entry, optional `index.css`, `mndw.lock.json`, artifact metadata,
and declared runtime assets in `dist/`. It does not create an upload ZIP. `zip` creates an archive
whose root contains `manifest.json`; it does not wrap the files in a `dist/` directory. Hidden files
are excluded. Both `dist/` and `*.zip` are ignored generated output in this repository; edit source
and manifest, then regenerate instead of editing generated files.

## Before uploading

1. Run the plugin's tests and `mndw validate` from the repository root.
2. Run `mndw pack` and inspect the output: confirm manifest/entry paths, locale files, CSS if
   expected, and every declared backend command are present.
3. Run `mndw zip`; inspect the archive and confirm `manifest.json` is at its root, not under `dist/`.
4. Review the backend source and declared routes. Device approval runs backend code with daemon
   privileges; only upload and approve code you trust.
5. Test read-only behavior first. Exercise device writes only with an intentional, reversible test
   and a real device you are authorized to modify. Packaging tests do not prove device behavior.

Upload the generated ZIP through the device's supported plugin-management flow; installation and
approval happen on the device and are separate from local validation, packing, and archiving. For
the complete source examples, see the [Hello widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/hello-widget)
and [device-name widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/rci-device-name-widget).
Return to the [plugin anatomy guide](/guides/plugin-anatomy) for the source/output file map.
