import {describe, expect, it} from 'vitest';
import {dragPosition, isClickWithinSlop} from './graph-interaction';

describe('graph interaction helpers', () => {
  it('projects pointer movement into graph coordinates', () => {
    expect(dragPosition({x: 10, y: 20}, {x: 4, y: 6}, {x: 2, y: 3})).toEqual({x: 12, y: 23});
  });

  it('classifies clicks using screen-space slop', () => {
    expect(isClickWithinSlop({x: 10, y: 10}, {x: 13, y: 12}, 4)).toBe(true);
    expect(isClickWithinSlop({x: 10, y: 10}, {x: 14, y: 12}, 4)).toBe(false);
  });
});
