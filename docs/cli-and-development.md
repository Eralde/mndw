# CLI and development

The `mndw` CLI is the plugin author loop. It validates the same v3 manifest
contract used by the SDK and prepares the files consumed by the host and
daemon.

## Commands

```text
mndw create <name>       scaffold a plugin
mndw dev <plugin>        run source plugin with local host and daemon
mndw validate <path>     validate manifest and entry checks
mndw pack <path>         build an isolated loadable plugin directory
mndw zip <path>          pack and create an uploadable archive
```

Common `create` choices are widget or page, vanilla/Svelte/Vue/Angular, and an
optional shell backend. The generated project uses `@mndw/sdk` and the
`--mndw-*` design tokens.

## Pack pipeline

`mndw pack` performs these steps:

1. read and validate the source manifest;
2. detect or select the frontend framework;
3. resolve package `mndw.productionEntry`, defaulting to `src/index.ts`;
4. bundle the selected TypeScript source with esbuild;
5. externalize host-provided shared dependencies;
6. emit the entry and fixed `index.css` output;
7. copy declared backend commands once with executable mode;
8. write a validated manifest and `mndw.lock.json`;
9. atomically replace the output directory.

The packer reads backend commands before mutating output. It rejects traversal,
missing declared commands, and shared dependencies that leaked into the bundle.

`mndw zip` puts `manifest.json` at archive root. This lets the daemon validate
an archive without knowing the author's source directory layout.

## Lock file and externals

The lock file records the plugin version, framework, SDK version, and versions
of shared dependencies used during the build. Shared bundles are versioned and
resolved through one import map in development and production.

Host-provided packages include the base RCI/RxJS/hash-wasm/d3 set, with Vue and
Angular additions. Plugins should not bundle those packages. The packer checks
the esbuild metafile for leaks before staging output. Packages absent from the
shared-dependency table remain plugin-bundled, which lets plugins use extensions
such as `d3-dag` without waiting for a host change.

## Source development

`mndw dev <plugin>` starts an isolated local environment:

```text
plugin source
  ├─ Vite virtual module → host frontend
  └─ symlinked builtin dir → local mndwd backend commands/services
```

The CLI validates first, creates temporary data and plugin roots, starts
`mndwd --dev --opkg stub`, waits for `/api/mgmt/list`, and then starts the host.
Signals or child failure stop both processes and remove only the temporary
directories created for that run.

Source HMR is transactional. A valid compatible change remounts the candidate;
an invalid manifest, topology change, or remount failure leaves the prior
plugin live or reports that restart is required.

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

At repository level, `pnpm dev` packs built-in plugins from `src/index.ts`, starts
a local daemon, waits for readiness, and starts the host under one supervisor.
This keeps development-only behavior such as MWS mock data available. The
ordinary `pnpm build-builtin-plugins` command continues to pack configured
production entries. The existing `MNDW_HOST_DEVICE` value continues to select
the real router for RCI/auth calls.

## Author loop

Use this sequence for a new plugin:

```bash
mndw create hello --type widget --framework svelte --backend sh
mndw dev hello
mndw validate hello
mndw pack hello
mndw zip hello
```

The resulting zip can be uploaded through the host's management UI or the
daemon management API. A backend zip remains staged until approval.
