# @mndw/cli

Command-line tools to create, validate, develop, and package mndw plugins.

## Part of mndw

mndw is a modular web dashboard for Keenetic/Netcraze routers. Everything in it is a plugin: a dashboard widget or a full page. See [the plugin author site](https://eralde.github.io/mndw/).

## Install and create a plugin

```sh
mkdir my-plugins && cd my-plugins
npm init -y
npm i -D @mndw/cli
npx mndw create my-widget
npx mndw dev my-widget --addr http://router.lan
```

Run commands from the plugins project and pass each plugin folder as an argument. The CLI installs the matching
platform `mndwd` binary automatically as an optional dependency.

## Commands

| Command | Purpose | Guide |
| --- | --- | --- |
| `create` | `npx mndw create <name>` scaffolds a widget or page. | [Project setup](https://eralde.github.io/mndw/guides/project-setup) |
| `dev` | `npx mndw dev <plugin-dir>` starts a local development session. | [Local development](https://eralde.github.io/mndw/guides/local-development) |
| `validate` | `npx mndw validate <plugin-dir>` checks manifest, entry, and locale catalogs. | [Validation and packaging](https://eralde.github.io/mndw/guides/validation-and-packaging) |
| `pack` | `npx mndw pack <plugin-dir>` builds the frontend and stages runtime files. | [Validation and packaging](https://eralde.github.io/mndw/guides/validation-and-packaging) |
| `zip` | `npx mndw zip <plugin-dir>` creates an upload archive. | [Validation and packaging](https://eralde.github.io/mndw/guides/validation-and-packaging) |

## Read on

See the [CLI reference](https://eralde.github.io/mndw/reference/cli), [plugin setup](https://eralde.github.io/mndw/guides/project-setup), and [local development guide](https://eralde.github.io/mndw/guides/local-development).
