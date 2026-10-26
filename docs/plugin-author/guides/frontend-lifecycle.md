# Frontend lifecycle

The host calls `createInstance(container, context)` once for each mounted plugin instance. Return an
object with `unmount()` so every listener, timer, subscription, and framework root can be released.
Widgets may also implement `onResize({w, h})`; dimensions are grid units. Pages do not receive widget
resize calls.

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk';

export function createInstance(
  container: HTMLElement,
  context: PluginContext,
): PluginInstance {
  const stopTheme = context.onThemeChange((theme) => {
    container.dataset.theme = theme;
  });
  const stopPalette = context.onPaletteChange(() => {
    // Recompute any colors held in JavaScript.
  });

  return {
    unmount(): void {
      stopTheme();
      stopPalette();
      container.replaceChildren();
    },
  };
}
```

The `PluginContext` also exposes the RCI manager, storage, i18n, host/device information, overlays,
and—only when declared in the manifest—`backend`. Read the exact
[`context.ts` contract](https://github.com/Eralde/mndw/blob/main/frontend/sdk/src/context.ts) and
[`PluginInstance` type](https://github.com/Eralde/mndw/blob/main/frontend/sdk/src/plugin.ts).

Framework adapters should release their own mount. For example, Svelte's `unmount(app)` may be
asynchronous; return or await that promise if teardown must finish before the host continues. Do not
rely on removing DOM nodes alone to stop subscriptions or background work. The
[Hello widget entry](https://github.com/Eralde/mndw/blob/main/plugins/examples/hello-widget/src/index.ts)
shows the Svelte adapter; its component also invalidates an in-flight request on destroy.
