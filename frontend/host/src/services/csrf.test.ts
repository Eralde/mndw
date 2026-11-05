import {describe, expect, it} from 'vitest';
import {CSRF_HEADERS} from './csrf.js';

describe('CSRF_HEADERS', () => {
  it('exports the daemon CSRF header as a frozen plain record', () => {
    expect(CSRF_HEADERS).toEqual({'X-Mndw-Csrf': '1'});
    expect(Object.isFrozen(CSRF_HEADERS)).toBe(true);
  });
});
