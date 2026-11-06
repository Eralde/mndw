# RxJS for plugin authors

An Observable represents values that may arrive over time: none, one, or many. It can complete when there are no more
values, or report an error. A subscription receives those notifications and owns work attached to that subscription.

A Promise represents one eventual result and starts its work when it is created. An Observable can represent a
continuing stream such as theme changes, and many RxJS Observables start their work when you subscribe. Use `await`
for one-off asynchronous results; subscribe when a plugin should react to later values. See the
[RxJS overview](https://rxjs.dev/guide/overview).

## Subscribe to values and errors

Pass an observer with `next` for values and `error` for failures:

```ts
const subscription = ctx.rciManager.queue({path: 'show.version'}).subscribe({
  next: (result) => {
    console.info(result);
  },
  error: (error: unknown) => {
    console.error('The RCI request failed', error);
  },
});
```

## Unsubscribe from work you own

The host completes every context stream it handed you on unmount, including theme, locale, palette, page-route,
event, localization, and ticker streams. You do not need to unsubscribe from those streams to release host resources.
Unsubscribe temporary work your plugin starts, such as a timer or a long-running request stream, in `unmount()`:

```ts
import {interval} from 'rxjs';
import type {PluginContext, PluginInstance} from '@mndw/sdk';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  container.dataset.theme = ctx.theme;
  const subscription = interval(1000).subscribe(() => {
    container.dataset.lastRefresh = String(Date.now());
  });

  return {
    unmount(): void {
      subscription.unsubscribe();
    },
  };
}
```

## Await one RCI response

For one request, `firstValueFrom` resolves with the first emitted value and rejects if the Observable errors before that
value. Handle that rejection with `try`/`catch`:

```ts
import {firstValueFrom} from 'rxjs';

export async function readVersion(): Promise<void> {
  try {
    const version = await firstValueFrom(ctx.rciManager.queue({path: 'show.version'}));
    console.info(version);
  } catch (error: unknown) {
    console.error('Could not read device version', error);
  }
}
```

## Save button: choose the operator for the user's intent

Check the RCI response for an embedded `status: "error"` before starting the confirmation read. A write can succeed as
an HTTP request while the device reports an RCI error; the [RCI guide](/guides/rci-api) explains that distinction.

Do not put `switchMap` directly on a Save-click stream around a device write. A later click would unsubscribe from the
earlier write Observable. Unsubscribing can stop listening or abort a request that has not completed, but it cannot
undo a write the device has already accepted. Instead, guard the click stream with `exhaustMap` or `concatMap`, then
put the read-after-write `switchMap` inside that guarded save. Catch errors inside the save so one failure does not end
the click stream:

```ts
import {EMPTY, Observable, catchError, concatMap, exhaustMap, map, switchMap} from 'rxjs';

type RciResponse = Record<string, unknown> | undefined;

function checkedWrite(description: string): Observable<RciResponse> {
  return ctx.rciManager.queue({path: 'system.description', data: description}).pipe(
    map((response) => {
      const statuses = response?.['status'];
      const rejected = Array.isArray(statuses) && statuses.some((entry: unknown) => {
        return typeof entry === 'object' && entry !== null && 'status' in entry && entry.status === 'error';
      });

      if (rejected) {
        throw new Error('The device rejected the save.');
      }

      return response;
    }),
  );
}

function saveAndConfirm(description: string): Observable<RciResponse> {
  return checkedWrite(description).pipe(
    switchMap(() => ctx.rciManager.queue({path: 'system.description'})),
    catchError((error: unknown) => {
      console.error('Save failed', error);
      return EMPTY;
    }),
  );
}

// Use exhaustMap to ignore extra Save clicks while one write and confirmation read are active.
function ignoreRepeatedSaveClicks(saveClicks$: Observable<string>): Observable<RciResponse> {
  return saveClicks$.pipe(exhaustMap((description) => saveAndConfirm(description)));
}

// Use concatMap to keep every Save click and run writes and confirmation reads in order.
function queueSaveClicks(saveClicks$: Observable<string>): Observable<RciResponse> {
  return saveClicks$.pipe(concatMap((description) => saveAndConfirm(description)));
}
```

Here `switchMap` belongs inside one guarded save: it starts the confirmation read only after the checked write emits.
Choose `exhaustMap` to ignore repeat clicks during a save, or `concatMap` to queue them in order. Keep the
subscription you create for the click stream and unsubscribe it in `unmount()`.

## Learn more

- [RxJS overview](https://rxjs.dev/guide/overview)
- [Learn RxJS](https://learnrxjs.io)
- [map](https://rxjs.dev/api/operators/map), [filter](https://rxjs.dev/api/operators/filter),
  [switchMap](https://rxjs.dev/api/operators/switchMap), [exhaustMap](https://rxjs.dev/api/operators/exhaustMap),
  [concatMap](https://rxjs.dev/api/operators/concatMap), [catchError](https://rxjs.dev/api/operators/catchError),
  [takeUntil](https://rxjs.dev/api/operators/takeUntil)
