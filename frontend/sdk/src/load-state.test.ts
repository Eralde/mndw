import {describe, expect, it} from 'vitest';
import type {LoadState} from './load-state.js';

describe('LoadState', () => {
  it('represents all lifecycle statuses', () => {
    const states: Array<LoadState<number, string>> = [
      {status: 'idle'},
      {status: 'loading'},
      {status: 'success', data: 1},
      {status: 'refreshing', data: 1},
      {status: 'error', error: 'offline'},
      {status: 'error', error: 'offline', data: 1},
      {status: 'unsupported', reason: 'not available'},
    ];

    expect(states).toHaveLength(7);
    expect(states[3]).toEqual({status: 'refreshing', data: 1});
    expect(states[6]).toEqual({status: 'unsupported', reason: 'not available'});
  });

  it('supports exhaustive status narrowing', () => {
    const describeState = (state: LoadState<number, string>): string => {
      switch (state.status) {
        case 'idle':
        case 'loading':
          return state.status;
        case 'success':
        case 'refreshing':
          return state.status + ':' + state.data;
        case 'error':
          return state.status + ':' + state.error + ':' + (state.data ?? 'none');
        case 'unsupported':
          return state.status + ':' + state.reason;
      }
    };

    expect(describeState({status: 'success', data: 3})).toBe('success:3');
    expect(describeState({status: 'error', error: 'offline', data: 3})).toBe('error:offline:3');
  });
});
