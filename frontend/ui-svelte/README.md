# @mndw/ui-svelte

Svelte table cell adapters for mndw UI.

## Part of mndw

mndw is a modular web dashboard for Keenetic/Netcraze routers. Everything in it is a plugin: a dashboard widget or a full page. See [the plugin author site](https://eralde.github.io/mndw/).

## Install

`mndw create` adds this adapter to `dependencies` for Svelte plugins. To add it by hand, install it in the plugin project; peer dependency: `svelte >=5.0.0`.

```sh
npm i @mndw/ui-svelte
```

## Use

`svelteCell<Row, Value>()(Component)` adapts framework components or templates to the table cell lifecycle:

```ts
import {svelteCell} from '@mndw/ui-svelte';
import NameCell from './NameCell.svelte';

const renderer = svelteCell<Row, string>()(NameCell);
```

## Read on

See the [table adapter guide](https://eralde.github.io/mndw/guides/ui-components#svelte) and [UI components overview](https://eralde.github.io/mndw/ui/).
