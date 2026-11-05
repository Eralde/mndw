# Plugin anatomy

The CLI creates a starting project with its framework, tests, manifest, and optional backend. This is
the `hello-widget` scaffold tree:

<!-- docs-check: scaffold hello-widget --type widget --framework svelte --backend sh -->
```text
hello-widget/
  backend/
    main.sh
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

The generated `package.json` is the plugin npm package manifest. It lists `@mndw/sdk`, `@mndw/ui`,
the framework wrapper such as `@mndw/ui-svelte`, and the build and test tools as npm dependencies.
The scaffold already includes the packages needed for its selected framework.

The `dist/` directory is not part of the scaffold. `mndw pack` generates it from the source tree and
manifest; it contains the bundled entry, runtime assets, lock and artifact metadata, and declared
backend commands. Do not edit generated output. See the
[lifecycle guide](/guides/frontend-lifecycle), [manifest guide](/guides/manifest), and the complete
[Hello widget tutorial](/tutorials/hello-widget).

Useful source references: [`hello-widget`](https://github.com/Eralde/mndw/tree/master/plugins/examples/hello-widget)
and [the plugin system contract](https://github.com/Eralde/mndw/blob/master/docs/plugin-system.md).
