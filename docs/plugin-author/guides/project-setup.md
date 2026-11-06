# Set up the plugins project

Create plugins in a regular Node.js project. You do not need a repository clone or Go unless you choose a Go backend.

## Before you start

- Node.js 22 or newer.
- npm (pnpm or Yarn also work; see the package manager note below).
- Go only for a Go backend.
- A [supported router](/) reachable from your computer for the RCI tutorial. After creating its plugin folder, run
  `npx mndw dev rci-device-name-widget --addr <router>` to reach it through the local daemon; mndw does not need to be
  installed on the router for development.
- A router with mndw installed to install a finished plugin. See [Install mndw](/install).
- On Windows, WSL for backend development. Read the [Windows guide](/guides/windows).

## Create a project and install the CLI

Make a plugins project, then install the CLI as a development dependency:

```sh
mkdir my-plugins && cd my-plugins
npm init -y
npm i -D @mndw/cli
```

The `mndw` CLI comes from `@mndw/cli`, a development dependency of the plugins project. It is installed into
`node_modules/.bin`; there is no global install. Run it through the package manager with commands such as
`npx mndw create`.

With pnpm, use `pnpm add -D @mndw/cli` and `pnpm exec mndw …`. With Yarn, use `yarn add -D @mndw/cli` and
`yarn mndw …`. Yarn requires `nodeLinker: node-modules` in `.yarnrc.yml`; Plug'n'Play is not supported.

## Create a plugin

Run the CLI from the plugins project (`my-plugins`). In an interactive terminal, choose a framework; Svelte is the
default. The plugin type defaults to `widget`.

```sh
npx mndw create hello-widget
```

Pass `--framework vanilla|svelte|vue|angular` or `--type widget|page` to choose directly. Add `--backend sh` for a shell
backend. A Go backend requires a vanilla page and Go installed. Add `--no-install` to create the files without
installing their dependencies. Otherwise, the CLI installs them with the package manager that invoked it.

For example, create a Svelte widget with a shell backend:

```sh
npx mndw create hello-widget --type widget --framework svelte --backend sh
```

The plugins project owns the CLI. Each plugin folder is a separate package with its own manifest, source files, and
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
or the [RCI tutorial](/tutorials/rci-device-name-widget). For all CLI commands, see the [CLI reference](/reference/cli).
