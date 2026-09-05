import {describe, expect, it, vi} from 'vitest';
import {currentTransitionLogFilters, filterTransitionLog} from './transition-log-filters';
import type {TransitionLogEntry} from './transition-log.types';

const entries: TransitionLogEntry[] = [
  {timestamp: 300, client: 'Laptop', from: 'A', to: 'B', band: null, segment: null, eventType: 'transition', id: '3'},
  {timestamp: 200, client: 'Phone', from: null, to: 'A', band: '2.4', segment: null, eventType: 'connected', id: '2'},
  {timestamp: 100, client: 'Laptop', from: 'B', to: null, band: null, segment: null, eventType: 'left', id: '1'},
];

describe('transition log filters', () => {
  it('applies event, text, and Current filters with AND semantics', () => {
    const result = filterTransitionLog(entries, {
      eventTypes: ['transition'],
      client: 'lap',
      source: 'a',
      target: 'b',
      currentSince: 250,
    });

    expect(result).toEqual([entries[0]]);
  });

  it('uses a captured Current baseline, not a rolling window', () => {
    vi.spyOn(Date, 'now').mockReturnValue(250);

    const filters = currentTransitionLogFilters(Date.now());

    expect(filters.currentSince).toBe(250);
    expect(filterTransitionLog(entries, filters).map((entry) => entry.id)).toEqual(['3']);
    vi.restoreAllMocks();
  });
});
