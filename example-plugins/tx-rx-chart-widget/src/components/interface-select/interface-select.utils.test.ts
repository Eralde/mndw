import {describe, expect, it} from 'vitest';
import {getDropdownPosition} from './interface-select.utils.js';

const viewport = {width: 800, height: 600};

describe('getDropdownPosition', () => {
  it('places a short panel below the trigger', () => {
    expect(getDropdownPosition(
      {left: 100, top: 100, bottom: 132, width: 200},
      viewport,
      3,
    )).toEqual({
      left: 100,
      top: 136,
      width: 200,
      maxHeight: 108,
      placement: 'below',
    });
  });

  it('flips above when below space is insufficient', () => {
    expect(
      getDropdownPosition(
        {left: 100, top: 500, bottom: 532, width: 200},
        viewport,
        10,
      ).placement,
    ).toBe('above');
  });

  it('keeps the panel inside horizontal viewport padding', () => {
    expect(
      getDropdownPosition(
        {left: 760, top: 100, bottom: 132, width: 60},
        viewport,
        2,
      ).left,
    ).toBe(612);
  });
});
