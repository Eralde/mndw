# CLI and development

The `mndw` CLI is the plugin author loop. It validates the same v2 manifest
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
3. bundle `src/index.ts` with esbuild;
4. externalize host-provided shared dependencies;
5. emit the entry and fixed `index.css` output;
6. copy declared backend scripts and daemon hooks;
7. write a validated manifest and `mndw.lock.json`;
8. atomically replace the output directory.

The packer reads backend assets before mutating output. It rejects traversal,
missing declared files, and shared dependencies that leaked into the bundle.

`mndw zip` puts `manifest.json` at archive root. This lets the daemon validate
an archive without knowing the author's source directory layout.

## Lock file and externals

The lock file records the plugin version, framework, SDK version, and versions
of shared dependencies used during the build. Shared bundles are versioned and
resolved through one import map in development and production.

Host-provided packages include the base RCI/RxJS/hash-wasm set, with Vue and
Angular additions. Plugins should not bundle those packages. The packer checks
the esbuild metafile for leaks before staging output.

## Source development

`mndw dev <plugin>` starts an isolated local environment:

```text
plugin source
  ├─ Vite virtual module → host frontend
  └─ symlinked builtin dir → local mndwd backend assets
```

The CLI validates first, creates temporary data and plugin roots, starts
`mndwd --dev --opkg stub`, waits for `/api/mgmt/list`, and then starts the host.
Signals or child failure stop both processes and remove only the temporary
directories created for that run.

Source HMR is transactional. A valid compatible change remounts the candidate;
an invalid manifest, topology change, or remount failure leaves the prior
plugin live or reports that restart is required.

At repository level, `pnpm dev` packs example plugins, starts a local daemon,
waits for readiness, and starts the host under one supervisor. The existing
`MNDW_HOST_DEVICE` value continues to select the real router for RCI/auth calls.

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

