import type {Ticker} from './ticker.js';

export interface RefreshLoopOptions<T> {
  load(signal: AbortSignal): Promise<T>;
  intervalMs: number;
  onSuccess(value: T): void;
  onError(error: unknown, isInitial: boolean): void;
}

export interface RefreshLoop {
  start(options?: {immediate?: boolean}): void;
  stop(): void;
  setIntervalMs(intervalMs: number): void;
}

/** Timers scoped to one plugin context. */
export interface PluginTimers {
  /** Creates a host-managed ticker destroyed when this plugin context ends. */
  createTicker(): Ticker;
  /** Creates a non-overlapping refresh loop stopped when this plugin context ends. */
  createRefreshLoop<T>(options: RefreshLoopOptions<T>): RefreshLoop;
}

/** @internal */
export function createPluginTimers(
  signal: AbortSignal,
  createTicker: () => Ticker,
  onActiveLoopCountChange?: (count: number) => void,
): PluginTimers {
  let disposed = signal.aborted;
  const loops = new Set<() => void>();

  const registerLoop = (stop: () => void): void => {
    if (!loops.has(stop)) {
      loops.add(stop);
      onActiveLoopCountChange?.(loops.size);
    }
  };

  const unregisterLoop = (stop: () => void): void => {
    if (loops.delete(stop)) {
      onActiveLoopCountChange?.(loops.size);
    }
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const stop of [...loops]) {
      stop();
    }
  };

  signal.addEventListener('abort', dispose, {once: true});

  const timers = Object.assign(Object.create(null) as PluginTimers, {
    createTicker,
    createRefreshLoop<T>(options: RefreshLoopOptions<T>): RefreshLoop {
      let active = false;
      let loading = false;
      let intervalMs = options.intervalMs;
      let intervalId: ReturnType<typeof setInterval> | null = null;
      let generation = 0;
      let requestController: AbortController | undefined;
      let loopDisposed = disposed;

      const clearTimer = (): void => {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };

      const stop = (): void => {
        if (active) {
          active = false;
          generation += 1;
          loading = false;
          clearTimer();
          requestController?.abort();
          requestController = undefined;
        }

        unregisterLoop(stop);
      };

      const run = (isInitial: boolean): void => {
        if (!active || loopDisposed || loading) {
          return;
        }

        loading = true;

        const requestGeneration = generation;
        const controller = new AbortController();

        requestController = controller;

        let request: Promise<T>;

        try {
          request = options.load(controller.signal);
        } catch (error) {
          loading = false;
          requestController = undefined;
          controller.abort();

          if (active && !loopDisposed && generation === requestGeneration) {
            options.onError(error, isInitial);
          }

          return;
        }

        void request.then((value) => {
          if (active && !loopDisposed && generation === requestGeneration) {
            options.onSuccess(value);
          }
        }, (error: unknown) => {
          if (active && !loopDisposed && generation === requestGeneration) {
            options.onError(error, isInitial);
          }
        }).finally(() => {
          if (generation === requestGeneration) {
            loading = false;

            if (requestController === controller) {
              requestController = undefined;
            }
          }
        });
      };

      const schedule = (): void => {
        clearTimer();
        intervalId = setInterval(() => run(false), intervalMs);
      };

      const loop: RefreshLoop & {dispose(): void} = {
        start(startOptions: {immediate?: boolean} = {}): void {
          if (active || loopDisposed || disposed) {
            return;
          }

          active = true;
          generation += 1;
          registerLoop(stop);
          schedule();

          if (startOptions.immediate !== false) {
            run(true);
          }
        },
        stop,
        setIntervalMs(next: number): void {
          intervalMs = next;

          if (active) {
            schedule();
          }
        },
        dispose(): void {
          loopDisposed = true;
          stop();
        },
      };

      return loop;
    },
  });

  return Object.freeze(timers);
}
