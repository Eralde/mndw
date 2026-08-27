import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRefreshLoop} from './refresh.js';

let onSuccess: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  onSuccess = vi.fn();
  onError = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('start', () => {
  it('loads once immediately, then on each interval', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('value');

    vi.advanceTimersByTime(3000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3000);
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not load immediately when immediate is false', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start({immediate: false});
    await flush();
    expect(load).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('value');
  });

  it('is idempotent — a second start does not double the schedule', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    loop.start();
    await flush();

    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('marks only the first load as initial', async () => {
    const load = vi.fn().mockRejectedValue(new Error('boom'));
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), true);

    vi.advanceTimersByTime(3000);
    await flush();
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), false);
  });

  it('keeps polling after an error', async () => {
    const load = vi.fn().mockRejectedValue(new Error('boom'));
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();

    for (let index = 0; index < 3; index += 1) {
      vi.advanceTimersByTime(3000);
      await flush();
    }

    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe('overlap', () => {
  it('skips a tick while a load is still in flight', async () => {
    let release: (value: string) => void = () => {};
    const load = vi.fn(() =>
      new Promise<string>((resolve) => {
        release = resolve;
      })
    );
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    release('value');
    await flush();
    vi.advanceTimersByTime(3000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('stop', () => {
  it('cancels the schedule and is idempotent', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    loop.stop();
    loop.stop();

    vi.advanceTimersByTime(30_000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('suppresses the callback of a request already in flight', async () => {
    let release: (value: string) => void = () => {};
    const load = vi.fn(() =>
      new Promise<string>((resolve) => {
        release = resolve;
      })
    );
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    loop.stop();
    release('value');
    await flush();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('suppresses a late rejection too', async () => {
    let reject: (error: Error) => void = () => {};
    const load = vi.fn(() =>
      new Promise<string>((_resolve, rejectFn) => {
        reject = rejectFn;
      })
    );
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    loop.stop();
    reject(new Error('late'));
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });

  it('drops a stale result when a stopped loop is started again', async () => {
    const releases: Array<(value: string) => void> = [];
    const load = vi.fn(() =>
      new Promise<string>((resolve) => {
        releases.push(resolve);
      })
    );
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    loop.stop();
    loop.start();
    await flush();

    expect(load).toHaveBeenCalledTimes(2);

    releases[0]('stale');
    await flush();
    expect(onSuccess).not.toHaveBeenCalled();

    releases[1]('fresh');
    await flush();
    expect(onSuccess).toHaveBeenCalledWith('fresh');
  });
});

describe('setIntervalMs', () => {
  it('changes the cadence without loading', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 3000, onSuccess, onError});

    loop.start();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    loop.setIntervalMs(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('resets the countdown rather than preserving elapsed time', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 10_000, onSuccess, onError});

    loop.start();
    await flush();

    vi.advanceTimersByTime(9000);
    loop.setIntervalMs(5000);
    await flush();

    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stores the value for a later start when inactive, without loading', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const loop = createRefreshLoop({load, intervalMs: 10_000, onSuccess, onError});

    loop.setIntervalMs(2000);
    await flush();
    expect(load).not.toHaveBeenCalled();

    loop.start();
    await flush();
    vi.advanceTimersByTime(2000);
    await flush();

    expect(load).toHaveBeenCalledTimes(2);
  });
});
