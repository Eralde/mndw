import {Subject, config} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {createPluginLifetime, hostSignal$, hostValue$} from './plugin-lifetime.js';

describe('plugin lifetime streams', () => {
  it('emits the current value on subscribe, then changes', () => {
    const lifetime = createPluginLifetime();
    const changes = new Subject<string>();
    const seen: string[] = [];
    const stream = hostValue$(() => 'current', (callback) => {
      const subscription = changes.subscribe(callback);

      return () => subscription.unsubscribe();
    }, lifetime);

    stream.subscribe((value) => seen.push(value));
    changes.next('next');

    expect(seen).toEqual(['current', 'next']);
  });

  it('completes all streams when the lifetime ends and removes the host listener', () => {
    const lifetime = createPluginLifetime();
    let activeListeners = 0;
    let completeCount = 0;
    const stream = hostSignal$((_callback) => {
      activeListeners += 1;

      return () => {
        activeListeners -= 1;
      };
    }, lifetime);

    stream.subscribe({complete: () => completeCount += 1});
    expect(activeListeners).toBe(1);

    lifetime.end();

    expect(activeListeners).toBe(0);
    expect(completeCount).toBe(1);
  });

  it('completes immediately for a subscription made after the end', () => {
    const lifetime = createPluginLifetime();
    const read = vi.fn(() => 'current');
    const listen = vi.fn(() => () => {});
    let completeCount = 0;

    lifetime.end();
    hostValue$(read, listen, lifetime).subscribe({complete: () => completeCount += 1});

    expect(completeCount).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('keeps delivering to other subscribers when one throws', async () => {
    const previousHandler = config.onUnhandledError;
    const unhandledError = vi.fn();
    const changes = new Subject<string>();
    const lifetime = createPluginLifetime();
    const seen: string[] = [];
    const stream = hostValue$(() => 'current', (callback) => {
      const subscription = changes.subscribe(callback);

      return () => subscription.unsubscribe();
    }, lifetime);

    config.onUnhandledError = unhandledError;

    try {
      stream.subscribe(() => {
        throw new Error('subscriber failed');
      });
      stream.subscribe((value) => seen.push(value));
      changes.next('next');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(seen).toEqual(['current', 'next']);
      expect(unhandledError).toHaveBeenCalledWith(expect.objectContaining({message: 'subscriber failed'}));
    } finally {
      config.onUnhandledError = previousHandler;
    }
  });

  it('ends idempotently', () => {
    const lifetime = createPluginLifetime();
    let endedCount = 0;

    lifetime.ended$.subscribe(() => endedCount += 1);
    lifetime.end();
    lifetime.end();

    expect(lifetime.ended).toBe(true);
    expect(endedCount).toBe(1);
  });
});
