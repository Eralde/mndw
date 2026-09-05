import {describe, expect, it} from 'vitest';
import {transitionLogCsv} from './transition-log-csv';

describe('transitionLogCsv', () => {
  it('serializes headers, ISO timestamps, and escaped fields', () => {
    const csv = transitionLogCsv([{
      timestamp: Date.UTC(2026, 8, 5, 10, 4, 10),
      client: 'Laptop, main',
      from: 'A',
      to: 'B',
      band: '5',
      segment: null,
      eventType: 'transition',
      id: '1',
    }]);

    expect(csv).toBe(
      'timestamp,client,source,target,band,segment,event type\n2026-09-05T10:04:10.000Z,"Laptop, main",A,B,5,,transition',
    );
  });

  it('returns headers for empty input', () => {
    expect(transitionLogCsv([])).toBe('timestamp,client,source,target,band,segment,event type');
  });
});
