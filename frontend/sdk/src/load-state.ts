export type LoadState<T, E = unknown> =
  | {status: 'idle'}
  | {status: 'loading'}
  | {status: 'success'; data: T}
  | {status: 'refreshing'; data: T}
  | {status: 'error'; error: E; data?: T}
  | {status: 'unsupported'; reason: string};
