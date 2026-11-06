# @mndw/sdk

Types, PluginContext, framework entry helpers, and design tokens for mndw plugins.

## Part of mndw

mndw is a modular web dashboard for Keenetic/Netcraze routers. Everything in it is a plugin: a dashboard widget or a full page. See [the plugin author site](https://eralde.github.io/mndw/).

## Install

```sh
npm i -D @mndw/sdk
```

`mndw create` normally adds the SDK and its framework entry helpers to the plugin project.

## Plugin entry

The host calls `createInstance` with a container and `PluginContext`; return `unmount` to release framework work.

```ts
import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import App from './App.svelte';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {backend: ctx.backend, i18n: ctx.i18n}});
  return {unmount: () => { void unmount(app); }};
}
```

## Package versioning

All `@mndw/*` packages share the product version. Scaffolds use a caret range based on the creating CLI version for
SDK, CLI, UI, and the selected UI adapter. While the product is `0.x`, breaking API, manifest, or protocol changes
bump the minor version; for example, `^0.1.2` stays within its minor and receives fixes. Moving to a new minor is a
coordinated upgrade of all `@mndw/*` packages. See [project setup](https://eralde.github.io/mndw/guides/project-setup#package-versioning).

## Entry points

| Import | API |
| --- | --- |
| `@mndw/sdk` | [Core types and context](https://eralde.github.io/mndw/api/sdk) |
| `@mndw/sdk/svelte` | [Svelte helpers](https://eralde.github.io/mndw/api/sdk/svelte) |
| `@mndw/sdk/vue` | [Vue helpers](https://eralde.github.io/mndw/api/sdk/vue) |
| `@mndw/sdk/angular` | [Angular helpers](https://eralde.github.io/mndw/api/sdk/angular) |
| `@mndw/sdk/tokens` | [Typed design tokens](https://eralde.github.io/mndw/api/sdk/tokens) |
| `@mndw/sdk/tokens.css` | [Token usage](https://eralde.github.io/mndw/guides/styling-and-ui) |
| `@mndw/sdk/testing` | [Test helpers](https://eralde.github.io/mndw/api/sdk/testing) |
| `@mndw/sdk/testing/vitest-project` | [Vitest project helper](https://eralde.github.io/mndw/api/sdk/testing/vitest-project) |
| `@mndw/sdk/bind-locale` | [Locale binding](https://eralde.github.io/mndw/api/sdk/bind-locale) |
| `@mndw/sdk/refresh` | [Refresh loop](https://eralde.github.io/mndw/api/sdk/refresh) |
| `@mndw/sdk/rrd` | [RRD helpers](https://eralde.github.io/mndw/api/sdk/rrd) |
| `@mndw/sdk/manifest.schema.json` | [Manifest guide](https://eralde.github.io/mndw/guides/manifest) |

## Read on

Start with the [plugin setup guide](https://eralde.github.io/mndw/guides/project-setup), [Hello Widget tutorial](https://eralde.github.io/mndw/tutorials/hello-widget), [frontend lifecycle](https://eralde.github.io/mndw/guides/frontend-lifecycle), and [SDK API reference](https://eralde.github.io/mndw/api/sdk).
