import {describe, expect, it} from 'vitest';
import {contrastRatio, meetsContrast} from './contrast.js';

describe('contrastRatio', () => {
  it('calculates black and white contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('returns one for identical colors', () => {
    expect(contrastRatio('#6c63ff', '#6c63ff')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#111111', '#eeeeee')).toBeCloseTo(contrastRatio('#eeeeee', '#111111'), 5);
  });

  it('supports short and alpha hex values', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff80', '#000000')).toBeCloseTo(21, 5);
  });

  it('checks a requested threshold', () => {
    expect(meetsContrast('#ffffff', '#000000', 4.5)).toBe(true);
    expect(meetsContrast('#777777', '#ffffff', 4.5)).toBe(false);
  });
});
