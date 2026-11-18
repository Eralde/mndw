# RCI API

## What RCI is

RCI is the router's HTTP API for reading and changing configuration, also used by its web interface. Plugins call it
through the host's `ctx.device.rci`; they do not need their own backend route. RCI calls are not declared in
`manifest.json` and do not use `ctx.backend.call()`.

The RCI types and response helper backed by `@rci-tools/core` are part of the plugin contract. Breaking RCI contract
changes ship with minor `mndw` versions.

## Request shape and responses

An RCI query has a dot-separated `path`, such as `show.version`. A write can pass its value in `data`:

```json
{"path":"system.description","data":"Office router"}
```

The response contains the requested data and may include a `status` list. A successful HTTP response can still contain
an RCI status entry with `status: "error"`; handle that device-level error separately from an Observable error such as
a network or HTTP failure. The [full RCI reference](https://github.com/Eralde/rci-tools/tree/master/docs) documents
paths, request data, response values, and status entries.

## Read one value

Use `query()` when one request should produce one result that you can `await`:

```ts
export async function readVersion(signal?: AbortSignal): Promise<void> {
  try {
    const result = await ctx.device.rci.query(
      {path: 'show.version'},
      signal === undefined ? undefined : {signal},
    );
    console.info(result);
  } catch (error: unknown) {
    console.error('Could not read device version', error);
  }
}
```

`query(query, options?)` queues the request and resolves with its first result. Its options extend the queue options with
an optional `AbortSignal`. Aborting stops waiting and unsubscribes from the result, but a request already queued is
still sent to the router; aborting a write does not roll it back. Use `execute()` to bypass the queue.

## Write deliberately and check the response

Start with read-only queries and validate the returned value. Device writes can have persistent or disruptive effects;
validate and explain the change, require an explicit user action, and handle both Observable errors and an RCI
`status: "error"` response. Do not issue configuration writes during mount or as a side effect of rendering. The
[device-name tutorial](/tutorials/rci-device-name-widget) shows a validated write, response checking, read-after-write
confirmation, and error handling.

## Choose a request method

The plugin-facing manager exposes `execute`, `queue`, `initBackgroundProcess`, and `queueBackgroundProcess`:

| Method | Use it for |
| --- | --- |
| `query(query, options?)` | A one-shot request that should join the batch queue and resolve as a Promise. Pass `{signal}` to stop waiting when its caller is cancelled. |
| `execute(query)` | A request that should run directly when its Observable is subscribed, without entering the manager's batch queue. Accepts one query or an array. |
| `queue(query)` | Regular requests that can join the manager's batch queue. Calls are batched with other queued work; accepts one query or an array. |
| `initBackgroundProcess(query)` | Creating a background-process handle that the caller starts with `.start()` or attaches to a running process with `.attachToRunning()`. Observe its `data$`, `result$`, `state$`, and `done$` streams. |
| `queueBackgroundProcess(query)` | Scheduling background processes in sequence with other queued processes for the same command path. It returns a process handle to observe or abort. |

The two background methods return handles with lifecycle methods and streams; they are not one-shot request Observables.
Processes returned by `initBackgroundProcess` are owned by their caller. Use the full
[RCI reference](https://github.com/Eralde/rci-tools/tree/master/docs) for the router-side command and background
process behavior. For Observable composition, cleanup, and Save-button operator choices, see
[RxJS for plugin authors](/guides/rxjs).
