import {describe, expect, it} from 'vitest';
import {getWidgetSize} from './widget-size.js';

describe('getWidgetSize', () => {
  it('passes through v2 grid units and applies optional minimums', () => {
    expect(getWidgetSize({w: 4, h: 3})).toEqual({w: 4, h: 3});
    expect(getWidgetSize({w: 2, h: 3, minW: 4, minH: 2})).toEqual({
      w: 4,
      h: 3,
      minW: 4,
      minH: 2,
    });
  });

  it('clamps height to minH in v2 grid units', () => {
    expect(getWidgetSize({w: 4, h: 2, minH: 3})).toEqual({w: 4, h: 3, minH: 3});
  });
});
