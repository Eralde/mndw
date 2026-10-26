# Direct RCI API

`PluginContext.rciManager` is the host's typed integration point for Keenetic RCI. Use it for device
operations that are part of the host/device API, not to create a shell or service backend route.
Direct RCI calls are not declared in `manifest.json` and do not use `context.backend.fetch()`.

## Queue a request

`queue()` accepts one `RciTask` and returns an RxJS `Observable` for its response:

```ts
const description$ = context.rciManager.queue({path: 'show.version'});
```

The manager batches independent `queue()` calls made close together (20 ms by default). Batching
does not mean passing an array to `queue()`; follow the installed `@rci-tools/core` types and send
one task per call. Subscribe or compose the Observable to receive a result. Transport and protocol
failures arrive through the Observable error channel; use `catchError` or a subscription error
handler to present a useful UI state.

An HTTP-level response can still contain an RCI `status` entry with `status: "error"`. Check the
response shape and convert that embedded device error into an application error before treating the
operation as successful. The device-name example does this in
[`device-description.ts`](https://github.com/Eralde/mndw/blob/main/plugins/examples/rci-device-name-widget/src/device-description.ts).

## Read and write deliberately

Start with read-only queries and validate the returned value. Device writes can have persistent or
disruptive effects; validate and explain the change, require an explicit user action, and handle a
rejected write separately from a transport failure. Do not issue configuration writes during mount
or as a side effect of rendering.

For related operations, compose Observables instead of converting them to Promises. Use an operator
that matches the UI intent: `exhaustMap` can ignore duplicate saves while one is active; `switchMap`
can make a read-after-write depend on the write completing; `concatMap` sequences queued work. Keep
errors inside the relevant inner stream when the outer intent stream should remain usable. Track
subscriptions and unsubscribe during `unmount()`; teardown prevents later UI updates but cannot
undo a write already accepted by the device.

Inject or wrap the manager behind a small interface so tests can supply a fake Observable-based
implementation. The [device-name tutorial](/tutorials/rci-device-name-widget) shows read, validated
write, read-after-write confirmation, error handling, and subscription cleanup. Its
[test helpers](https://github.com/Eralde/mndw/tree/main/plugins/examples/rci-device-name-widget/src)
provide a reference for faking the manager without contacting hardware.
