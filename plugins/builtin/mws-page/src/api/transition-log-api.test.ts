import {Subject} from 'rxjs';
import type {RciBackgroundProcess, RciManager} from '@rci-tools/core';
import {describe, expect, it, vi} from 'vitest';
import {createTransitionLogStream} from './transition-log-api';

describe('createTransitionLogStream', () => {
  it('starts the native background handshake and exposes normalized frames', () => {
    const data$ = new Subject<unknown>();
    const abort = vi.fn(() => true);
    const process = {data$: data$.asObservable(), abort} as unknown as RciBackgroundProcess;
    const queueBackgroundProcess = vi.fn(() => process);
    const rci = {queueBackgroundProcess} as unknown as RciManager;
    const stream = createTransitionLogStream(rci, {client: 'Laptop'});
    const next = vi.fn();

    stream.data$.subscribe(next);
    data$.next({continued: true});
    data$.next({log: {event: {timestamp: 'Sep  5 10:00:00', mac: 'client', ap: 'ap'}}});

    expect(queueBackgroundProcess).toHaveBeenCalledWith({path: 'show.mws.log'});
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[0]?.[0]).toEqual([]);
    expect(next.mock.calls[1]?.[0][0]).toMatchObject({client: 'Laptop', eventType: 'connected'});

    stream.process.abort();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('keeps transport errors visible to consumers', () => {
    const data$ = new Subject<unknown>();
    const process = {data$: data$.asObservable(), abort: vi.fn()} as unknown as RciBackgroundProcess;
    const stream = createTransitionLogStream({queueBackgroundProcess: () => process} as unknown as RciManager);
    const error = new Error('transport');
    const observed = vi.fn();

    stream.data$.subscribe({error: observed});
    data$.error(error);

    expect(observed).toHaveBeenCalledWith(error);
  });
});
