import type {Subscription} from 'rxjs';
import type {NormalizedLogRecord} from './log-types';
import type {SystemLogApi, SystemLogStream} from './system-log-api';

const RECONNECT_DELAYS = [1, 2, 5, 10, 30] as const;

export interface LogConnectionState {
  status: 'connected' | 'reconnecting' | 'error';
  reconnectSeconds: number;
  streamError: string;
  snapshotError: string;
}

export interface LogConnectionTimers {
  setInterval(callback: () => void, delayMilliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface LogConnectionControllerOptions {
  api: Pick<SystemLogApi, 'showLogOnce' | 'startLogStream'>;
  onBatch(batch: NormalizedLogRecord[], source: 'snapshot' | 'stream'): void;
  onState(state: LogConnectionState): void;
  timers?: LogConnectionTimers;
}

export interface LogConnectionController {
  start(): void;
  reconnectNow(): void;
  dispose(): void;
}

interface ConnectionAttempt {
  stream?: SystemLogStream;
  snapshotSubscription?: Subscription;
  dataSubscription?: Subscription;
  doneSubscription?: Subscription;
  terminal: boolean;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function createLogConnectionController(options: LogConnectionControllerOptions): LogConnectionController {
  const timers = options.timers ?? {
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: (timer) => globalThis.clearInterval(timer),
  };
  const state: LogConnectionState = {
    status: 'connected',
    reconnectSeconds: 0,
    streamError: '',
    snapshotError: '',
  };
  let activeAttempt: ConnectionAttempt | undefined;
  let reconnectTimer: ReturnType<typeof setInterval> | undefined;
  let retryIndex = 0;
  let started = false;
  let disposed = false;

  function publishState(): void {
    if (!disposed) {
      options.onState({...state});
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) {
      timers.clearInterval(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function stopAttempt(attempt: ConnectionAttempt): void {
    attempt.snapshotSubscription?.unsubscribe();
    attempt.dataSubscription?.unsubscribe();
    attempt.doneSubscription?.unsubscribe();
    attempt.stream?.process.abort();
  }

  function stopActiveAttempt(): void {
    if (activeAttempt) {
      const attempt = activeAttempt;

      activeAttempt = undefined;
      attempt.terminal = true;
      stopAttempt(attempt);
    }
  }

  const lifecycle = {
    beginAttempt: (): void => {},
  };

  function scheduleReconnect(attempt: ConnectionAttempt, error?: unknown, setupError = false): void {
    if (disposed || activeAttempt !== attempt || attempt.terminal) {
      return;
    }

    attempt.terminal = true;
    attempt.dataSubscription?.unsubscribe();
    attempt.doneSubscription?.unsubscribe();
    clearReconnectTimer();
    state.streamError = errorText(error, 'System log stream ended');
    state.status = setupError ? 'error' : 'reconnecting';

    const delay = RECONNECT_DELAYS[Math.min(retryIndex, RECONNECT_DELAYS.length - 1)] ?? 30;

    retryIndex += 1;
    state.reconnectSeconds = delay;
    publishState();
    reconnectTimer = timers.setInterval(() => {
      if (disposed || activeAttempt !== attempt) {
        clearReconnectTimer();

        return;
      }

      state.reconnectSeconds -= 1;

      if (state.reconnectSeconds <= 0) {
        clearReconnectTimer();
        lifecycle.beginAttempt();
      } else {
        publishState();
      }
    }, 1000);
  }

  function finishBatch(attempt: ConnectionAttempt, batch: NormalizedLogRecord[], source: 'snapshot' | 'stream'): void {
    if (disposed || activeAttempt !== attempt || (source === 'stream' && attempt.terminal)) {
      return;
    }

    options.onBatch(batch, source);
    retryIndex = 0;
    state.streamError = '';
    state.snapshotError = '';

    if (source === 'stream') {
      state.status = 'connected';
      state.reconnectSeconds = 0;
      clearReconnectTimer();
    }

    publishState();
  }

  function startSnapshot(attempt: ConnectionAttempt): void {
    if (disposed || activeAttempt !== attempt) {
      return;
    }

    try {
      attempt.snapshotSubscription = options.api.showLogOnce().subscribe({
        next: (batch) => finishBatch(attempt, batch, 'snapshot'),
        error: (error: unknown) => {
          if (!disposed && activeAttempt === attempt) {
            state.snapshotError = errorText(error, 'System log snapshot failed');
            publishState();
          }
        },
      });
    } catch (error) {
      if (!disposed && activeAttempt === attempt) {
        state.snapshotError = errorText(error, 'System log snapshot failed');
        publishState();
      }
    }
  }

  lifecycle.beginAttempt = (): void => {
    if (disposed) {
      return;
    }

    const replacesAttempt = activeAttempt !== undefined;

    clearReconnectTimer();
    stopActiveAttempt();

    const attempt: ConnectionAttempt = {terminal: false};

    activeAttempt = attempt;

    if (replacesAttempt) {
      state.status = 'reconnecting';
    }

    state.reconnectSeconds = 0;
    publishState();

    try {
      attempt.stream = options.api.startLogStream();
      attempt.dataSubscription = attempt.stream.data$.subscribe({
        next: (batch) => finishBatch(attempt, batch, 'stream'),
        error: (error: unknown) => scheduleReconnect(attempt, error),
        complete: () => scheduleReconnect(attempt),
      });

      if (!disposed && activeAttempt === attempt && !attempt.terminal) {
        attempt.doneSubscription = attempt.stream.process.done$.subscribe({
          next: () => scheduleReconnect(attempt),
          error: (error: unknown) => scheduleReconnect(attempt, error),
          complete: () => scheduleReconnect(attempt),
        });
      }
    } catch (error) {
      scheduleReconnect(attempt, error, true);
    }

    startSnapshot(attempt);
  };

  return {
    start(): void {
      if (disposed || started) {
        return;
      }

      started = true;
      lifecycle.beginAttempt();
    },
    reconnectNow(): void {
      if (disposed) {
        return;
      }

      started = true;
      retryIndex = 0;
      lifecycle.beginAttempt();
    },
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      clearReconnectTimer();
      stopActiveAttempt();
    },
  };
}
