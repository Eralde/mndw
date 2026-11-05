# Direct RCI API

`PluginContext.rciManager` is the host's typed integration point for Keenetic RCI. Use it for device
operations that are part of the host/device API, not to create a shell or service backend route.
Direct RCI calls are not declared in `manifest.json` and do not use `ctx.backend.fetch()`.

The plugin facade exposes `execute`, `queue`, `initBackgroundProcess`, and
`queueBackgroundProcess` from the underlying RCI manager. It does not expose manager lifecycle or
destruction methods.

## Read one response

`queue()` accepts one `RciTask` and returns an RxJS `Observable` for its response. Use
`firstValueFrom` when one request should produce one result that you can `await`:

```ts
import {firstValueFrom} from 'rxjs';

export async function readVersion(): Promise<void> {
  try {
    const result = await firstValueFrom(ctx.rciManager.queue({path: 'show.version'}));
    console.info(result);
  } catch (error: unknown) {
    console.error('Could not read device version', error);
  }
}
```

The manager batches independent `queue()` calls made close together (20 ms by default). Batching does
not mean passing an array to `queue()`; follow the installed `@rci-tools/core` types and send one task
per call. Transport and protocol failures reject `firstValueFrom` through the Observable error
channel. An HTTP-level response can still contain an RCI `status` entry with `status: "error"`; check
the response shape and handle that device error separately. The device-name example does this in
[`device-description.ts`](https://github.com/Eralde/mndw/blob/master/plugins/examples/rci-device-name-widget/src/device-description.ts).

## Read and write deliberately

Start with read-only queries and validate the returned value. Device writes can have persistent or
disruptive effects; validate and explain the change, require an explicit user action, and handle a
rejected write separately from a transport failure. Do not issue configuration writes during mount or
as a side effect of rendering.

For sequences and user-intent streams, keep the work in Observables. Choose an operator that matches
the UI intent: `exhaustMap` can ignore duplicate saves while one is active; `switchMap` can make a
read-after-write depend on the write completing; `concatMap` sequences queued work. Keep errors inside
the relevant inner stream when the outer intent stream should remain usable. Unsubscribe plugin-owned
subscriptions during `unmount()`; teardown prevents later UI updates but cannot undo a write already
accepted by the device.

Inject or wrap the manager behind a small interface so tests can supply a fake Observable-based
implementation. The [device-name tutorial](/tutorials/rci-device-name-widget) shows read, validated
write, read-after-write confirmation, error handling, and subscription cleanup. Its
[test helpers](https://github.com/Eralde/mndw/tree/master/plugins/examples/rci-device-name-widget/src)
provide a reference for faking the manager without contacting hardware.
