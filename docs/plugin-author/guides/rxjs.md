# RxJS for plugin authors

An Observable represents values that may arrive over time: none, one, or many. It can complete when
there are no more values, or report an error. A subscription receives those notifications and owns
the work attached to that subscription.

A Promise represents one eventual result and starts its work when it is created. An Observable can
represent a continuing stream such as theme changes, and many RxJS Observables start their work when
you subscribe. Use `await` for one-off asynchronous results; subscribe when a plugin should react to
later values.

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

The host completes every context stream it handed you on unmount, including theme, locale, palette,
page-route, event, localization, and ticker streams. You do not need to unsubscribe from those streams
to release host resources. Unsubscribe temporary work your plugin starts, such as a timer or a
long-running request stream, in `unmount()`:

```ts
import {interval} from 'rxjs';
import type {PluginContext, PluginInstance} from '@mndw/sdk';

export function createInstance(_ctx: PluginContext): PluginInstance {
  const subscription = interval(1000).subscribe(() => {
    console.info('refresh');
  });

  return {
    unmount(): void {
      subscription.unsubscribe();
    },
  };
}
```

## Await one RCI response

For one request, `firstValueFrom` resolves with the first emitted value and rejects if the Observable
errors before that value. Handle that rejection with `try`/`catch`:

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

## Operators

- [`map`](https://rxjs.dev/api/operators/map)
- [`filter`](https://rxjs.dev/api/operators/filter)
- [`switchMap`](https://rxjs.dev/api/operators/switchMap)
- [`exhaustMap`](https://rxjs.dev/api/operators/exhaustMap)
- [`concatMap`](https://rxjs.dev/api/operators/concatMap)
- [`catchError`](https://rxjs.dev/api/operators/catchError)
- [`takeUntil`](https://rxjs.dev/api/operators/takeUntil)
