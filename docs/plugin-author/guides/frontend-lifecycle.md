# Frontend lifecycle

The host calls `createInstance(container, ctx)` once for each mounted plugin instance. Return an
object with `unmount()` so framework roots, DOM listeners, and work the plugin started can be released.
Widgets may implement `onResize({w, h})`; dimensions are grid units. Pages do not receive widget resize
calls.

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  ctx.theme$.subscribe((theme) => {
    container.dataset.theme = theme;
  });
  ctx.palette$.subscribe((palette) => {
    container.dataset.paletteTokenCount = String(Object.keys(palette).length);
  });

  const ticker = ctx.createTicker();
  ticker.start(1000);
  ticker.tick$.subscribe(({timestamp}) => {
    container.dataset.lastTick = String(timestamp);
  });

  return {
    onResize({w, h}): void {
      container.dataset.size = `${w}x${h}`;
    },
    unmount(): void {
      container.replaceChildren();
    },
  };
}
```

## Context streams

The live getters `ctx.theme`, `ctx.locale`, and `ctx.palette` return the current snapshot. Subscribe to
the corresponding Observable when the UI needs updates over time. This table shows whether each stream
emits its current value on subscribe:

| Stream | Emits | Current value on subscribe? |
| --- | --- | --- |
| `ctx.theme$` | Current host theme and later theme changes | Yes |
| `ctx.locale$` | Current host locale and later locale changes | Yes |
| `ctx.palette$` | Current applied palette and later palette changes | Yes |
| `ctx.i18n.change$` | A signal when the catalog or host locale changes | No |
| `ctx.pageRoute.childPath$` | Current page child path and later navigation | Yes; pages only |
| `ctx.events?.select$(topics)` | Events matching the selected topics | No; with event permissions |
| `ctx.events?.resync$` | A signal to refresh after an event-stream resync | No; with event permissions |
| `ticker.tick$` | Periodic ticks after `ticker.start()` | No |

The host completes every stream it handed you on unmount. You do not need to unsubscribe from those
context streams; unsubscribe temporary subscriptions for work you started, such as timers or request
streams. Each `ctx.createTicker()` call returns one handle for a ticker use. The host destroys every
handle on unmount, and its `tick$` completes then too.

`ctx.pageRoute` exists only for page plugins. `ctx.events` exists only when the manifest declares
event permissions, and `ctx.backend` exists only when the manifest declares callable backend routes.
Check the context kind before using a page route, and narrow optional services before calling them:

```ts
if (ctx.kind === 'page') {
  void ctx.pageRoute.navigate('/details');
}

ctx.events?.select$('wan').subscribe((event) => {
  console.info(event.topic);
});

if (ctx.backend !== undefined) {
  void ctx.backend.fetch('status');
}
```

`ctx.telemetry.fetchProjected(range)` returns a Promise for projected telemetry data, not a stream. It
accepts an `AbortSignal` when the request should be cancelled during teardown.

## Framework helpers

Svelte treats an Observable as a store. Assign the context stream to a local store variable, then use
`$theme$` in markup:

```svelte
<script lang="ts">
  import type {PluginContext} from '@mndw/sdk';

  export let ctx: PluginContext;
  const theme$ = ctx.theme$;
</script>

<p>Theme: {$theme$}</p>
```

Vue helpers convert context Observables into scope-bound refs. `useTranslator` makes localization
updates reactive in the same component:

```vue
<script setup lang="ts">
  import type {PluginContext} from '@mndw/sdk';
  import {useLocale, useObservable, useTheme, useTranslator} from '@mndw/sdk/vue';

  const {ctx} = defineProps<{ctx: PluginContext}>();
  const theme = useTheme(ctx);
  const locale = useLocale(ctx);
  const palette = useObservable(ctx.palette$, ctx.palette);
  const translator = useTranslator(ctx.i18n);
</script>

<template>
  <p>{{ theme }} · {{ locale }} · {{ translator.locale }} · {{ Object.keys(palette).length }}</p>
</template>
```

In Angular, `toSignal` exposes an Observable as a signal. `createTranslatorSignals` tracks catalog
changes and ties its subscription to `DestroyRef`:

```ts
import {type DestroyRef} from '@angular/core';
import {toSignal} from '@angular/core/rxjs-interop';
import type {PluginContext} from '@mndw/sdk';
import {createTranslatorSignals} from '@mndw/sdk/angular';

export function pluginState(ctx: PluginContext, destroyRef: DestroyRef): object {
  return {
    theme: toSignal(ctx.theme$, {initialValue: ctx.theme}),
    palette: toSignal(ctx.palette$, {initialValue: ctx.palette}),
    translator: createTranslatorSignals(ctx.i18n, destroyRef),
  };
}
```

Framework adapters should also release their own mount. For example, Svelte's `unmount(app)` may be
asynchronous; return or await that promise if teardown must finish before the host continues. Do not
rely on removing DOM nodes alone to stop plugin-owned work. The
[Hello widget entry](https://github.com/Eralde/mndw/blob/master/plugins/examples/hello-widget/src/index.ts)
shows the Svelte adapter; its component also invalidates an in-flight request on destroy.
