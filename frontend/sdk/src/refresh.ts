export interface RefreshLoopOptions<T> {
  load(): Promise<T>;
  intervalMs: number;
  onSuccess(value: T): void;
  onError(error: unknown, isInitial: boolean): void;
}

export interface RefreshLoop {
  start(options?: {immediate?: boolean}): void;
  stop(): void;
  setIntervalMs(intervalMs: number): void;
}

export function createRefreshLoop<T>(options: RefreshLoopOptions<T>): RefreshLoop {
  let active = false;
  let loading = false;
  let intervalMs = options.intervalMs;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let generation = 0;

  const clearTimer = (): void => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const run = (isInitial: boolean): void => {
    if (!active || loading) {
      return;
    }

    loading = true;

    const requestGeneration = generation;
    let request: Promise<T>;

    try {
      request = options.load();
    } catch (error) {
      loading = false;

      if (active && generation === requestGeneration) {
        options.onError(error, isInitial);
      }

      return;
    }

    void request.then((value) => {
      if (active && generation === requestGeneration) {
        options.onSuccess(value);
      }
    }, (error: unknown) => {
      if (active && generation === requestGeneration) {
        options.onError(error, isInitial);
      }
    }).finally(() => {
      if (generation === requestGeneration) {
        loading = false;
      }
    });
  };

  const schedule = (): void => {
    clearTimer();
    intervalId = setInterval(() => run(false), intervalMs);
  };

  return {
    start: (startOptions: {immediate?: boolean} = {}): void => {
      if (active) {
        return;
      }

      active = true;
      generation += 1;
      schedule();

      if (startOptions.immediate !== false) {
        run(true);
      }
    },

    stop: (): void => {
      if (!active) {
        return;
      }

      active = false;
      generation += 1;
      loading = false;
      clearTimer();
    },

    setIntervalMs: (next: number): void => {
      intervalMs = next;

      if (active) {
        schedule();
      }
    },
  };
}
