import {describe, expect, it} from 'vitest';
import {isAtBottom} from './scroll.js';

describe('isAtBottom', () => {
  it('treats the bottom and a few pixels above it as at the bottom', () => {
    expect(isAtBottom({scrollTop: 800, scrollHeight: 1000, clientHeight: 200})).toBe(true);
    expect(isAtBottom({scrollTop: 793, scrollHeight: 1000, clientHeight: 200})).toBe(true);
    expect(isAtBottom({scrollTop: 791, scrollHeight: 1000, clientHeight: 200})).toBe(false);
  });

  it('treats a list that does not scroll as at the bottom', () => {
    expect(isAtBottom({scrollTop: 0, scrollHeight: 200, clientHeight: 200})).toBe(true);
    expect(isAtBottom({scrollTop: 0, scrollHeight: 0, clientHeight: 0})).toBe(true);
  });

  it('accepts an explicit threshold', () => {
    expect(isAtBottom({scrollTop: 780, scrollHeight: 1000, clientHeight: 200}, 20)).toBe(true);
    expect(isAtBottom({scrollTop: 779, scrollHeight: 1000, clientHeight: 200}, 20)).toBe(false);
  });
});
