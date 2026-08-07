export interface RefreshLoopOptions<T> {
  load(): Promise<T>;
  intervalMs: number;
  onSuccess(value: T): void;
  onError(error: unknown, isInitial: boolean): void;
}

export interface RefreshLoop {
  start(): void;
  stop(): void;
}

export function createRefreshLoop<T>(options: RefreshLoopOptions<T>): RefreshLoop {
  let active = false;
  let loading = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const run = (isInitial: boolean): void => {
    if (!active || loading) {
      return;
    }

    loading = true;

    let request: Promise<T>;

    try {
      request = options.load();
    } catch (error) {
      loading = false;

      if (active) {
        options.onError(error, isInitial);
      }

      return;
    }

    void request.then((value) => {
      if (active) {
        options.onSuccess(value);
      }
    }, (error: unknown) => {
      if (active) {
        options.onError(error, isInitial);
      }
    }).finally(() => {
      loading = false;
    });
  };

  return {
    start: (): void => {
      if (active) {
        return;
      }

      active = true;
      intervalId = setInterval(() => run(false), options.intervalMs);
      run(true);
    },
    stop: (): void => {
      if (!active) {
        return;
      }

      active = false;

      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}
