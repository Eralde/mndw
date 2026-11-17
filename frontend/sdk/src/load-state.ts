/**
 * `unsupported.reason` explains why a capability or data state is unavailable; it does not mean a
 * request failed. Show it as muted `role="status"` text, as cpu-temp-widget does for unsupported
 * temperature data. Reserve red `role="alert"` for failures the user can act on, and include a Retry
 * action for retryable failures.
 */
export type LoadState<T, E = unknown> =
  | {status: 'idle'}
  | {status: 'loading'}
  | {status: 'success'; data: T}
  | {status: 'refreshing'; data: T}
  | {status: 'error'; error: E; data?: T}
  | {status: 'unsupported'; reason: string};
