import type {PluginRciManager} from '@mndw/sdk';
import {Subject, firstValueFrom, of} from 'rxjs';
import type {RciBackgroundProcess, RciQuery} from '@rci-tools/core';
import {describe, expect, it, vi} from 'vitest';
import validResponse from './fixtures/log-response.json';
import {createSystemLogApi} from './system-log-api';

describe('createSystemLogApi', () => {
  it('keeps one-shot and background requests Observable-based with exact payloads', async () => {
    const showResponse$ = new Subject<unknown>();
    const clearResponse$ = new Subject<unknown>();
    const streamData$ = new Subject<unknown>();
    const abort = vi.fn(() => true);
    const process = {
      data$: streamData$.asObservable(),
      done$: new Subject(),
      state$: new Subject(),
      abort,
    } as unknown as RciBackgroundProcess;
    const queue = vi.fn((query: RciQuery) => {
      if (query.path === 'system.log.clear') {
        return clearResponse$.asObservable();
      }

      return showResponse$.asObservable();
    });
    const queueBackgroundProcess = vi.fn(() => process);
    const rci = {queue, queueBackgroundProcess} as unknown as PluginRciManager;
    const api = createSystemLogApi(rci);

    const oncePromise = firstValueFrom(api.showLogOnce());

    expect(queue).toHaveBeenCalledWith({path: 'show.log', data: {'once': true, 'max-lines': 500}});

    const stream = api.startLogStream();

    expect(queueBackgroundProcess).toHaveBeenCalledWith({path: 'show.log', data: {'max-lines': 500}});
    expect(stream.process).toBe(process);

    const clearPromise = firstValueFrom(api.clearLog());

    showResponse$.next(validResponse);
    streamData$.next(validResponse);
    clearResponse$.next({cleared: true});

    expect(await oncePromise).toEqual([
      {id: 1, timestamp: 'Aug  1 12:00:00', ident: 'system', level: 'Info', label: 'Info', text: 'booted'},
      {id: 2, timestamp: 'Aug  1 12:00:01', ident: 'router', level: 'Warning', label: 'Warning', text: 'degraded'},
    ]);
    expect(await clearPromise).toEqual({cleared: true});
    expect(queue).toHaveBeenCalledWith({path: 'system.log.clear'});
    expect(abort).not.toHaveBeenCalled();
  });

  it('normalizes stream values and drops malformed records through Observables', async () => {
    const streamData$ = new Subject<unknown>();
    const queue = vi.fn(() => of({log: {1: {}}}));
    const process = {
      data$: streamData$.asObservable(),
      done$: new Subject(),
      state$: new Subject(),
      abort: vi.fn(() => true),
    } as unknown as RciBackgroundProcess;
    const rci = {
      queue,
      queueBackgroundProcess: vi.fn(() => process),
    } as unknown as PluginRciManager;
    const api = createSystemLogApi(rci);

    await expect(firstValueFrom(api.showLogOnce())).resolves.toEqual([]);

    const stream = api.startLogStream();
    const streamPromise = firstValueFrom(stream.data$);

    streamData$.next({log: {1: {}}});

    await expect(streamPromise).resolves.toEqual([]);
  });
});
