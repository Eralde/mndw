# CLI commands

Install `@mndw/cli` in your plugins project as described in [project setup](/guides/project-setup). Run commands with
`npx mndw` from that project, passing the plugin folder as `<plugin-dir>`.

| Command | Purpose | Guide |
| --- | --- | --- |
| `create` | `npx mndw create <name>` scaffolds a widget or page. | [Project setup](/guides/project-setup) |
| `dev` | `npx mndw dev <plugin-dir>` runs a plugin with the development host. | [Local development](/guides/local-development) |
| `validate` | `npx mndw validate <plugin-dir>` checks its manifest, entry, and locale catalogs. | [Validation and packaging](/guides/validation-and-packaging) |
| `pack` | `npx mndw pack <plugin-dir>` builds the frontend and stages runtime files in `dist/`. | [Validation and packaging](/guides/validation-and-packaging) |
| `zip` | `npx mndw zip <plugin-dir>` creates an upload archive. | [Validation and packaging](/guides/validation-and-packaging) |

For example, validate and package the `hello-widget` plugin folder from the plugins project:

```sh
npx mndw validate hello-widget
npx mndw pack hello-widget
npx mndw zip hello-widget
```
