import validResponse from './fixtures/log-response.json';
import malformedResponse from './fixtures/log-malformed.json';
import {describe, expect, it} from 'vitest';
import {SystemLogParseError, normalizeLogResponse} from './log-normalizer';

describe('normalizeLogResponse', () => {
  it('normalizes keyed records in numeric id order', () => {
    expect(normalizeLogResponse(validResponse)).toEqual([
      {id: 1, timestamp: 'Aug  1 12:00:00', ident: 'system', level: 'Info', label: 'Info', text: 'booted'},
      {id: 2, timestamp: 'Aug  1 12:00:01', ident: 'router', level: 'Warning', label: 'Warning', text: 'degraded'},
    ]);
  });

  it('throws a typed parse error for malformed records', () => {
    expect(() => normalizeLogResponse(malformedResponse)).toThrow(SystemLogParseError);
    expect(() => normalizeLogResponse({log: []})).toThrow(SystemLogParseError);
  });

  it('accepts a continued marker without records', () => {
    expect(normalizeLogResponse({continued: true})).toEqual([]);
  });

  it('keeps only newest numeric ids up to the response cap', () => {
    const log: Record<string, unknown> = {};

    for (let id = 1; id <= 501; id += 1) {
      log[String(id)] = {
        timestamp: `Aug  1 12:${String(Math.floor(id / 60)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}`,
        ident: 'system',
        message: {level: 'Debug', label: 'Debug', text: `record ${id}`},
      };
    }

    const records = normalizeLogResponse({log});

    expect(records).toHaveLength(500);
    expect(records[0]?.id).toBe(2);
    expect(records[499]?.id).toBe(501);
  });
});
