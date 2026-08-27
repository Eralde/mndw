import chokidar from 'chokidar';

const DEFAULT_DEBOUNCE_MS = 150;
const ON_RESULT_TIMEOUT_MS = 10_000;
const BASELINE_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/.dev-data/**',
  '**/.cache/go-build/**',
  '**/.gocache/**',
  '**/go-build/**',
] as const;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface WatchBuildOptions<T> {
  readonly paths: readonly string[];
  readonly ignore?: readonly string[];
  readonly debounceMs?: number;
  readonly build: (changed: readonly string[]) => Promise<T>;
  readonly onResult: (result: BuildOutcome<T>, context: BuildGenerationContext) => void | Promise<void>;
}

export type BuildOutcome<T> =
  | {readonly ok: true; readonly value: T; readonly changed: readonly string[]; readonly generation: number}
  | {readonly ok: false; readonly error: Error; readonly changed: readonly string[]; readonly generation: number};

export interface BuildGenerationContext {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface WatchCreateOptions {
  readonly ignored: readonly string[];
  readonly followSymlinks: false;
  readonly awaitWriteFinish: {
    readonly stabilityThreshold: 75;
    readonly pollInterval: 10;
  };
}

export interface WatchHandle {
  onChange(listener: (changedPath: string) => void): void;
  close(): Promise<void>;
}

export interface WatchDeps {
  readonly createWatcher?: (paths: readonly string[], options: WatchCreateOptions) => WatchHandle;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (timer: TimerHandle) => void;
}

function createChokidarWatcher(paths: readonly string[], options: WatchCreateOptions): WatchHandle {
  const watcher = chokidar.watch([...paths], {
    ignored: [...options.ignored],
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: options.awaitWriteFinish,
  });
  let listener: ((changedPath: string) => void) | undefined;
  const forward = (changedPath: string): void => listener?.(changedPath);

  watcher.on('add', forward);
  watcher.on('change', forward);
  watcher.on('error', (error: unknown) => {
    console.error('[mndw dev] source watcher error:', error);
  });

  return {
    onChange: (nextListener) => {
      listener = nextListener;
    },
    close: (): Promise<void> => watcher.close(),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Watches source paths and serializes debounced builds plus their result side effects. */
export function watchAndBuild<T>(opts: WatchBuildOptions<T>, deps: WatchDeps = {}): WatchHandle {
  const createWatcher = deps.createWatcher ?? createChokidarWatcher;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const sourceWatcher = createWatcher(opts.paths, {
    ignored: [...new Set([...BASELINE_IGNORES, ...(opts.ignore ?? [])])],
    followSymlinks: false,
    awaitWriteFinish: {stabilityThreshold: 75, pollInterval: 10},
  });
  const pendingPaths = new Set<string>();
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let debounceTimer: TimerHandle | undefined;
  let running = false;
  let closed = false;
  let generationCounter = 0;
  let currentGeneration = 0;
  let closePromise: Promise<void> | undefined;
  const listeners = new Set<(changedPath: string) => void>();

  const schedule = (): void => {
    if (closed) {
      return;
    }

    if (debounceTimer !== undefined) {
      clearTimer(debounceTimer);
    }

    debounceTimer = setTimer(() => {
      debounceTimer = undefined;
      void drain();
    }, debounceMs);
  };

  const drain = async (): Promise<void> => {
    if (closed || running || pendingPaths.size === 0) {
      return;
    }

    running = true;
    const changed = [...pendingPaths];
    pendingPaths.clear();
    const generation = ++generationCounter;
    currentGeneration = generation;
    let invalidated = false;
    const context: BuildGenerationContext = {
      generation,
      isCurrent: () => !closed && !invalidated && currentGeneration === generation,
    };

    let outcome: BuildOutcome<T>;

    try {
      outcome = {
        ok: true,
        value: await opts.build(changed),
        changed,
        generation,
      };
    } catch (error) {
      outcome = {ok: false, error: asError(error), changed, generation};
    }

    let timeoutTimer: TimerHandle | undefined;
    let completed = false;
    const resultPromise = Promise.resolve()
      .then(() => opts.onResult(outcome, context))
      .catch((error: unknown) => {
        console.error('[mndw dev] watch result handler failed:', asError(error));
      })
      .then(() => {
        completed = true;
      });
    const timeoutPromise = new Promise<void>((resolveTimeout) => {
      timeoutTimer = setTimer(resolveTimeout, ON_RESULT_TIMEOUT_MS);
    });

    await Promise.race([resultPromise, timeoutPromise]);

    if (timeoutTimer !== undefined) {
      clearTimer(timeoutTimer);
    }

    if (!completed) {
      invalidated = true;
      console.error(`[mndw dev] watch result handler exceeded ${ON_RESULT_TIMEOUT_MS} ms; ignoring late side effects`);
    }

    running = false;

    if (!closed && pendingPaths.size > 0) {
      void drain();
    }
  };

  sourceWatcher.onChange((changedPath) => {
    if (closed) {
      return;
    }

    pendingPaths.add(changedPath);
    schedule();
    for (const listener of listeners) {
      listener(changedPath);
    }
  });

  return {
    onChange: (listener) => {
      listeners.add(listener);
    },
    close: (): Promise<void> => {
      if (closePromise !== undefined) {
        return closePromise;
      }

      closed = true;
      currentGeneration = 0;
      pendingPaths.clear();

      if (debounceTimer !== undefined) {
        clearTimer(debounceTimer);
        debounceTimer = undefined;
      }

      closePromise = sourceWatcher.close();

      return closePromise;
    },
  };
}
