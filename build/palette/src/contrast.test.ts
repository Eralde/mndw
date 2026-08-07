import {describe, expect, it} from 'vitest';
import {contrastRatio, meetsContrast} from './contrast.js';

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1 for identical colors', () => {
    expect(contrastRatio('#6c63ff', '#6c63ff')).toBeCloseTo(1, 5);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#111111', '#eeeeee')).toBeCloseTo(contrastRatio('#eeeeee', '#111111'), 5);
  });
});

describe('meetsContrast', () => {
  it('passes 4.5 target for black on white', () => {
    expect(meetsContrast('#000000', '#ffffff', 4.5)).toBe(true);
  });

  it('fails 4.5 target for mid-grey on white', () => {
    expect(meetsContrast('#999999', '#ffffff', 4.5)).toBe(false);
  });
});
