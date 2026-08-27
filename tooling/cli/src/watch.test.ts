import {afterEach, describe, expect, it, vi} from 'vitest';

import {type WatchCreateOptions, type WatchHandle, watchAndBuild} from './watch.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {promise, resolve: resolvePromise, reject: rejectPromise};
}

interface FakeWatcher extends Omit<WatchHandle, 'close'> {
  close: ReturnType<typeof vi.fn>;
  emit(path: string): void;
}

function fakeWatcher(): FakeWatcher {
  let listener: ((changedPath: string) => void) | undefined;

  return {
    onChange: (nextListener) => {
      listener = nextListener;
    },
    close: vi.fn(() => Promise.resolve()),
    emit: (path) => listener?.(path),
  };
}

describe('watchAndBuild', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces changes during the trailing debounce and passes a path union', async () => {
    vi.useFakeTimers();

    const source = fakeWatcher();
    const build = vi.fn((changed: readonly string[]) => Promise.resolve(changed.length));
    const outcomes: unknown[] = [];
    const handle = watchAndBuild({
      paths: ['/src/**/*.ts'],
      build,
      onResult: (result) => {
        outcomes.push(result);
      },
    }, {createWatcher: () => source});

    source.emit('/src/a.ts');
    await vi.advanceTimersByTimeAsync(100);
    source.emit('/src/b.ts');
    await vi.advanceTimersByTimeAsync(149);
    expect(build).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    vi.runAllTicks();

    expect(build).toHaveBeenCalledWith(['/src/a.ts', '/src/b.ts']);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ok: true, value: 2, changed: ['/src/a.ts', '/src/b.ts'], generation: 1});

    await handle.close();
  });

  it('serializes a queued build until current build and onResult settle', async () => {
    vi.useFakeTimers();

    const source = fakeWatcher();
    const firstBuild = deferred<number>();
    const resultGate = deferred<void>();
    const build = vi.fn()
      .mockImplementationOnce(async () => firstBuild.promise)
      .mockResolvedValueOnce(2);
    const handle = watchAndBuild({
      paths: ['/src'],
      build,
      onResult: async (result) => {
        if (result.ok && result.generation === 1) {
          await resultGate.promise;
        }
      },
    }, {createWatcher: () => source});

    source.emit('/src/one.ts');
    await vi.advanceTimersByTimeAsync(150);
    expect(build).toHaveBeenCalledTimes(1);

    source.emit('/src/two.ts');
    await vi.advanceTimersByTimeAsync(150);
    firstBuild.resolve(1);
    vi.runAllTicks();
    expect(build).toHaveBeenCalledTimes(1);

    resultGate.resolve();
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(build).toHaveBeenLastCalledWith(['/src/two.ts']);

    await handle.close();
  });

  it('delivers build rejection as a failed outcome and keeps watching', async () => {
    vi.useFakeTimers();

    const source = fakeWatcher();
    const build = vi.fn()
      .mockRejectedValueOnce(new Error('broken edit'))
      .mockResolvedValueOnce('good');
    const outcomes: unknown[] = [];
    const handle = watchAndBuild({
      paths: ['/src'],
      build,
      onResult: (result) => {
        outcomes.push(result);
      },
    }, {createWatcher: () => source});

    source.emit('/src/first.ts');
    await vi.advanceTimersByTimeAsync(150);
    expect(outcomes[0]).toMatchObject({ok: false, changed: ['/src/first.ts'], generation: 1});
    expect((outcomes[0] as {error: unknown}).error).toBeInstanceOf(Error);

    source.emit('/src/second.ts');
    await vi.advanceTimersByTimeAsync(150);
    expect(build).toHaveBeenCalledTimes(2);
    expect(outcomes[1]).toMatchObject({ok: true, value: 'good', generation: 2});

    await handle.close();
  });

  it('closes source watcher and cancels a pending debounce timer', async () => {
    vi.useFakeTimers();

    const source = fakeWatcher();
    const build = vi.fn(() => Promise.resolve());
    const handle = watchAndBuild({paths: ['/src'], build, onResult: () => undefined}, {
      createWatcher: () => source,
    });

    source.emit('/src/pending.ts');
    await handle.close();
    await vi.advanceTimersByTimeAsync(150);

    expect(build).not.toHaveBeenCalled();
    expect(source.close.mock.calls).toHaveLength(1);
  });

  it('passes followSymlinks false, baseline ignores, and low awaitWriteFinish values', async () => {
    const source = fakeWatcher();
    let options: WatchCreateOptions | undefined;
    const handle = watchAndBuild({
      paths: ['/src/**/*.go'],
      ignore: ['/src/backend/demo'],
      build: () => Promise.resolve(),
      onResult: () => undefined,
    }, {
      createWatcher: (_paths, watcherOptions) => {
        options = watcherOptions;

        return source;
      },
    });

    expect(options).toEqual({
      ignored: expect.arrayContaining([
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        '**/.dev-data/**',
        '**/.cache/go-build/**',
        '**/.gocache/**',
        '**/go-build/**',
        '/src/backend/demo',
      ]),
      followSymlinks: false,
      awaitWriteFinish: {stabilityThreshold: 75, pollInterval: 10},
    });

    await handle.close();
  });

  it('releases the build lock after the onResult safety timeout', async () => {
    vi.useFakeTimers();

    const source = fakeWatcher();
    const resultGate = deferred<void>();
    const build = vi.fn().mockResolvedValueOnce(1)
.mockResolvedValueOnce(2);
    const contexts: {generation: number; isCurrent(): boolean}[] = [];
    const handle = watchAndBuild({
      paths: ['/src'],
      build,
      onResult: async (_result, context) => {
        contexts.push(context);

        if (context.generation === 1) {
          await resultGate.promise;
        }
      },
    }, {createWatcher: () => source});

    source.emit('/src/first.ts');
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(contexts[0]?.isCurrent()).toBe(false);

    source.emit('/src/second.ts');
    await vi.advanceTimersByTimeAsync(150);
    expect(build).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.generation).toBe(2);

    resultGate.resolve();
    vi.runAllTicks();
    await handle.close();
  });

  it('does not touch the sentinel after an onResult safety timeout', async () => {
    vi.useFakeTimers();

    const source = fakeWatcher();
    const resultGate = deferred<void>();
    const touchSentinel = vi.fn();
    const handle = watchAndBuild({
      paths: ['/src'],
      build: () => Promise.resolve(),
      onResult: async (_result, context) => {
        await resultGate.promise;

        if (context.isCurrent()) {
          touchSentinel();
        }
      },
    }, {createWatcher: () => source});

    source.emit('/src/late.ts');
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10_000);
    resultGate.resolve();
    vi.runAllTicks();

    expect(touchSentinel).not.toHaveBeenCalled();
    await handle.close();
  });
});
