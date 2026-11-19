import {Observable, Subject, of, throwError} from 'rxjs';
import {expect, expectTypeOf, it, vi} from 'vitest';
import type {GenericObject, TaskResult, TypedRciQuery} from '@rci-tools/core';
import {PLUGIN_RCI_MANAGER_METHODS, type PluginRciManager, createPluginRci} from './rci.js';

function createRci(queue: (...args: unknown[]) => Observable<unknown>): PluginRciManager {
  return createPluginRci({
    execute: (() => of(undefined)) as never,
    queue: queue as never,
    initBackgroundProcess: (() => ({})) as never,
    queueBackgroundProcess: (() => ({})) as never,
  });
}

it('exposes exactly the plugin RCI manager methods', () => {
  expect(PLUGIN_RCI_MANAGER_METHODS).toEqual(['execute', 'queue', 'initBackgroundProcess', 'queueBackgroundProcess']);
  expectTypeOf<keyof PluginRciManager>().toEqualTypeOf<
    'execute' | 'queue' | 'initBackgroundProcess' | 'queueBackgroundProcess' | 'query'
  >();
  expectTypeOf<Exclude<keyof PluginRciManager, 'query'>>().toEqualTypeOf<
    (typeof PLUGIN_RCI_MANAGER_METHODS)[number]
  >();
});

it('provides Promise overloads matching queued single and batch results', () => {
  const rci = createRci(() => of({version: '1'}));
  const typedQuery: TypedRciQuery<{version: string}> = {path: 'show.version'};
  const singleResult = rci.query(typedQuery);
  const batchResult = rci.query([{path: 'show.version'}, {path: 'show.system'}] as const);
  const genericBatchResult = rci.query([{path: 'show.version'}] as Array<{path: string}>);

  expectTypeOf(singleResult).toEqualTypeOf<Promise<{version: string} | undefined>>();
  expectTypeOf(batchResult).toEqualTypeOf<Promise<[GenericObject | undefined, GenericObject | undefined]>>();
  expectTypeOf(genericBatchResult).toEqualTypeOf<Promise<Array<GenericObject | undefined>>>();
  expectTypeOf(rci.query([{path: 'show.version'}] as Array<{path: string}>)).toMatchTypeOf<Promise<TaskResult>>();
});

it('forwards queue options without passing the abort signal to the manager', async () => {
  const queue = vi.fn(() => of({version: '1'}));
  const rci = createRci(queue);
  const controller = new AbortController();
  const query = {path: 'show.version'};

  await expect(rci.query(query, {saveConfiguration: true, isPriorityTask: false, signal: controller.signal}))
    .resolves.toEqual({version: '1'});

  expect(queue).toHaveBeenCalledWith(query, {saveConfiguration: true, isPriorityTask: false});
});

it('rejects an already-aborted signal before subscribing to the queue', async () => {
  const queue = vi.fn(() => of({version: '1'}));
  const rci = createRci(queue);
  const controller = new AbortController();
  const reason = new Error('cancelled');

  controller.abort(reason);

  await expect(rci.query({path: 'show.version'}, {signal: controller.signal})).rejects.toBe(reason);
  expect(queue).not.toHaveBeenCalled();
});

it('rejects with AbortError when an aborted signal has no reason', async () => {
  const queue = vi.fn(() => new Observable<unknown>(() => undefined));
  const rci = createRci(queue);
  const target = new EventTarget();
  let aborted = false;
  const signal = Object.defineProperties(target, {
    aborted: {get: () => aborted},
    reason: {get: () => undefined},
  }) as AbortSignal;
  const result = rci.query({path: 'show.version'}, {signal});

  aborted = true;
  target.dispatchEvent(new Event('abort'));

  await expect(result).rejects.toMatchObject({name: 'AbortError'});
});

it('unsubscribes from the queue when aborted while waiting', async () => {
  const subject = new Subject<unknown>();
  let unsubscribed = false;
  const rci = createRci(() =>
    new Observable((subscriber) => {
      const subscription = subject.subscribe(subscriber);

      return () => {
        unsubscribed = true;
        subscription.unsubscribe();
      };
    })
  );
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const result = rci.query({path: 'show.version'}, {signal: controller.signal});

  controller.abort(reason);

  await expect(result).rejects.toBe(reason);
  expect(unsubscribed).toBe(true);
});

it('rejects when the queued request errors', async () => {
  const reason = new Error('request failed');
  const rci = createRci(() => throwError(() => reason));

  await expect(rci.query({path: 'show.version'})).rejects.toBe(reason);
});
