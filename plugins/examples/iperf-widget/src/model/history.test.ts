import {describe, expect, it} from 'vitest';
import {type HistoryEntry, pushHistory} from './history.js';

const entry = (at: number): HistoryEntry => ({
  at,
  server: 'example.net:5201',
  pingMs: 7,
  jitterMs: 1,
  downloadBps: 412_000_000,
  uploadBps: 188_000_000,
});

describe('pushHistory', () => {
  it('keeps newest result first and caps history at ten entries', () => {
    const history = Array.from({length: 11}, (_value, index) => entry(10 - index));
    const next = pushHistory(history, entry(11));

    expect(next).toHaveLength(10);
    expect(next.map((result) => result.at)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(history).toHaveLength(11);
  });
});
