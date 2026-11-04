# Set up a plugin project

Create plugins in a regular Node.js project. You do not need a repository clone or Go unless you choose a Go backend.

## Before you start

- Node.js 22 or newer.
- npm, pnpm, or Yarn.
- A router reachable on your LAN only if you plan to follow the [RCI tutorial](/tutorials/rci-device-name-widget).

> **Windows:** Backend development uses WSL. Read the [Windows guide](/guides/windows) before you choose a backend.

## Create a project and install the CLI

Make an outer project for your plugins, then install the CLI there:

::: code-group

```sh [npm]
mkdir my-plugins && cd my-plugins
npm init -y
npm i -D @mndw/cli
```

```sh [pnpm]
mkdir my-plugins && cd my-plugins
pnpm init
pnpm add -D @mndw/cli
```

```sh [yarn]
mkdir my-plugins && cd my-plugins
yarn init -y
# In .yarnrc.yml, set nodeLinker: node-modules.
yarn add -D @mndw/cli
```

:::

Yarn Plug'n'Play is not supported; use `nodeLinker: node-modules` as shown above.

## Create a plugin

Run the CLI from `my-plugins`. In an interactive terminal, choose a framework; Svelte is the default. The plugin type
defaults to `widget`.

::: code-group

```sh [npm]
npx mndw create hello-widget
```

```sh [pnpm]
pnpm exec mndw create hello-widget
```

```sh [yarn]
yarn mndw create hello-widget
```

:::

Pass `--framework vanilla|svelte|vue|angular` or `--type widget|page` to choose directly. Add `--backend sh` for a shell
backend. A Go backend requires a vanilla page and Go installed. Add `--no-install` to create the files without
installing their dependencies. Otherwise, the CLI installs them with the package manager that invoked it.

For example, create a Svelte widget with a shell backend:

::: code-group

```sh [npm]
npx mndw create hello-widget --type widget --framework svelte --backend sh
```

```sh [pnpm]
pnpm exec mndw create hello-widget --type widget --framework svelte --backend sh
```

```sh [yarn]
yarn mndw create hello-widget --type widget --framework svelte --backend sh
```

:::

The outer project owns the CLI. Each plugin is a separate package with its own manifest, source files, and
`package.json`:

```text
my-plugins/
  package.json          # the CLI dependency
  hello-widget/
    manifest.json
    package.json        # this plugin's dependencies and scripts
    src/
      App.svelte
      index.ts
```

The CLI installs the matching platform package for `mndwd` as an optional dependency of `@mndw/cli`. You do not need
Go to run `mndw dev` for a shell or backendless plugin. Go is needed only for a Go backend.

If npm reports that the platform package is missing after you reuse a `package-lock.json` made on another OS, delete
`package-lock.json` and `node_modules`, then run `npm install` again.

Next, try the [local development guide](/guides/local-development), the [Hello Widget tutorial](/tutorials/hello-widget),
or the [RCI tutorial](/tutorials/rci-device-name-widget).
