import {describe, expect, it} from 'vitest';
import {availablePopoverHeight, selectPresentation} from './select-position.js';

describe('select presentation', () => {
  it('uses sheet presentation at and below 600px', () => {
    expect(selectPresentation(601)).toBe('popover');
    expect(selectPresentation(600)).toBe('sheet');
  });
});

describe('select popover height', () => {
  it('uses the larger available region above or below the trigger', () => {
    expect(availablePopoverHeight({top: 300, bottom: 332}, {width: 1200, height: 868})).toBe(520);
    expect(availablePopoverHeight({top: 756, bottom: 788}, {width: 390, height: 844})).toBe(740);
  });

  it('always leaves at least one pixel for a fully clipped trigger', () => {
    expect(availablePopoverHeight({top: 0, bottom: 844}, {width: 390, height: 844})).toBe(1);
  });
});
