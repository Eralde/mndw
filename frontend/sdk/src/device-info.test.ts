import {describe, expect, it} from 'vitest';
import {parseCapabilityList} from './device-info.js';

describe('parseCapabilityList', () => {
  it('trims entries, drops empties, and preserves order', () => {
    expect(parseCapabilityList(' wifi, ,USB, wifi ,,')).toEqual(['wifi', 'USB', 'wifi']);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseCapabilityList('')).toEqual([]);
  });
});
