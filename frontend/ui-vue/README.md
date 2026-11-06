# @mndw/ui-vue

Vue table cell adapters for mndw UI.

## Part of mndw

mndw is a modular web dashboard for Keenetic/Netcraze routers. Everything in it is a plugin: a dashboard widget or a full page. See [the plugin author site](https://eralde.github.io/mndw/).

## Install

`mndw create` adds this adapter to `dependencies` for Vue plugins. To add it by hand, install it in the plugin project; peer dependency: `vue >=3.0.0`.

```sh
npm i @mndw/ui-vue
```

## Use

`vueCell<Row, Value>()(Component)` adapts framework components or templates to the table cell lifecycle:

```ts
import {vueCell} from '@mndw/ui-vue';
import NameCell from './NameCell.vue';

const renderer = vueCell<Row, string>()(NameCell);
```

## Read on

See the [table adapter guide](https://eralde.github.io/mndw/guides/ui-components#vue) and [UI components overview](https://eralde.github.io/mndw/ui/).
