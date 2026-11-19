import type {QueueOptions, RciManager, RciQuery, RciResponseOf, RciResultsOf, TaskResult} from '@rci-tools/core';
import {Observable, firstValueFrom, race} from 'rxjs';

export const PLUGIN_RCI_MANAGER_METHODS = [
  'execute',
  'queue',
  'initBackgroundProcess',
  'queueBackgroundProcess',
] as const satisfies readonly (keyof RciManager)[];

export type PluginRciManagerMethod = (typeof PLUGIN_RCI_MANAGER_METHODS)[number];

type PluginRciBatchResultsConstraint<T, Q extends readonly unknown[]> = [T] extends [never]
  ? { -readonly [K in keyof Q]: unknown }
  : Array<T | undefined>;

export type PluginRciQueryOptions = QueueOptions & {signal?: AbortSignal};

export interface PluginRciQuery {
  /**
   * Queue an RCI request and resolve with its first result. Aborting stops waiting; a queued request is still sent to
   * the router, and a write is not rolled back. Use `execute()` to bypass the queue.
   */
  <T extends object = never, Q extends RciQuery = RciQuery, R = [T] extends [never] ? RciResponseOf<Q> : T>(
    query: Q,
    options?: PluginRciQueryOptions,
  ): Promise<R | undefined>;
  <
    T = never,
    Q extends readonly [] | readonly RciQuery[] = readonly RciQuery[],
    R extends PluginRciBatchResultsConstraint<T, Q> = [T] extends [never] ? RciResultsOf<Q> : Array<T | undefined>,
  >(
    query: Q,
    options?: PluginRciQueryOptions,
  ): Promise<R>;
  (query: RciQuery | Array<RciQuery>, options?: PluginRciQueryOptions): Promise<TaskResult>;
}

export type PluginRciManager =
  & Pick<
    RciManager,
    'execute' | 'queue' | 'initBackgroundProcess' | 'queueBackgroundProcess'
  >
  & {query: PluginRciQuery};

function abortError(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new DOMException('The operation was aborted.', 'AbortError') : signal.reason;
}

function abortObservable(signal: AbortSignal): Observable<never> {
  return new Observable((subscriber) => {
    const onAbort = (): void => {
      subscriber.error(abortError(signal));
    };

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener('abort', onAbort, {once: true});

    return () => signal.removeEventListener('abort', onAbort);
  });
}

/** Creates the frozen plugin RCI facade and implements `query()` over the manager's `queue()`. */
export function createPluginRci(manager: Pick<RciManager, PluginRciManagerMethod>): PluginRciManager {
  const query = (request: RciQuery | Array<RciQuery>, options?: PluginRciQueryOptions): Promise<unknown> => {
    const {signal, ...queueOptions} = options ?? {};
    const forwardedQueueOptions: QueueOptions | undefined = options === undefined ? undefined : queueOptions;

    if (signal?.aborted === true) {
      return Promise.resolve().then(() => {
        throw abortError(signal);
      });
    }

    const queued = manager.queue(request, forwardedQueueOptions);

    return firstValueFrom(signal === undefined ? queued : race(queued, abortObservable(signal)));
  };
  const facade = Object.create(null) as Record<PropertyKey, unknown>;

  for (const method of PLUGIN_RCI_MANAGER_METHODS) {
    facade[method] = manager[method].bind(manager);
  }

  facade.query = query as PluginRciQuery;

  return Object.freeze(facade) as PluginRciManager;
}
