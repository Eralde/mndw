import type {Observable} from 'rxjs';

export interface TickerTick {
  readonly timestamp: number;
  readonly drift: number;
}

/** Host-managed periodic updates bound to one plugin context lifetime. */
export interface Ticker {
  start(intervalMs: number): void;
  setInterval(intervalMs: number): void;
  stop(): void;
  readonly tick$: Observable<TickerTick>;
  destroy(): void;
}
