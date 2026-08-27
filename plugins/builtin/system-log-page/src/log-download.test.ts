import {describe, expect, it, vi} from 'vitest';
import type {NormalizedLogRecord} from './log-types';
import {downloadLog, formatLogText} from './log-download';

const records: NormalizedLogRecord[] = [
  {id: 1, timestamp: 'Aug  1 12:00:00', ident: 'system', level: 'Info', label: 'Info', text: 'booted'},
  {id: 2, timestamp: 'Aug  1 12:00:01', ident: 'router', level: 'Error', label: 'Error', text: 'failed'},
];

describe('log download', () => {
  it('formats every loaded record with one deterministic line', () => {
    expect(formatLogText(records)).toBe(
      'Aug  1 12:00:00 system [Info] booted\nAug  1 12:00:01 router [Error] failed\n',
    );
  });

  it('creates and revokes a text download through the browser seam', () => {
    const click = vi.fn();
    const anchor = document.createElement('a');

    anchor.click = click;

    const createObjectURL = vi.fn(() => 'blob:system-log');
    const revokeObjectURL = vi.fn();
    const createAnchor = vi.fn(() => anchor);

    downloadLog(records, {createObjectURL, revokeObjectURL, createAnchor});

    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({type: 'text/plain;charset=utf-8'}));
    expect(anchor.download).toBe('system-log.txt');
    expect(anchor.href).toContain('blob:system-log');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:system-log');
  });
});
