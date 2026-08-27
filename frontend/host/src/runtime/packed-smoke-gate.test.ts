import {describe, expect, it} from 'vitest';
import {decidePackedSmoke} from './packed-smoke-gate.js';

describe('decidePackedSmoke', () => {
  it('runs when packed artifacts are ready', () => {
    expect(decidePackedSmoke(true, undefined)).toBe('run');
    expect(decidePackedSmoke(true, '1')).toBe('run');
  });

  it('fails when packed artifacts are missing by default', () => {
    expect(decidePackedSmoke(false, undefined)).toBe('fail');
    expect(decidePackedSmoke(false, '')).toBe('fail');
    expect(decidePackedSmoke(false, 'true')).toBe('fail');
  });

  it('skips only when explicitly opted out', () => {
    expect(decidePackedSmoke(false, '1')).toBe('skip');
  });
});
