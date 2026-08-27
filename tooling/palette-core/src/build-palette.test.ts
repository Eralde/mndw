import {describe, expect, it} from 'vitest';
import {SEED, buildPalette, validatePalette} from './build-palette.js';

describe('buildPalette', () => {
  it('preserves deterministic default values and contrast guarantees', () => {
    expect(buildPalette('light')).toMatchObject({
      bg: '#f7fcfd',
      surface: '#edf2f3',
      text: '#0c1217',
      accent: SEED.primary,
    });

    expect(validatePalette(buildPalette('dark')).filter((result) => !result.pass)).toEqual([]);
    expect(validatePalette(buildPalette('light')).filter((result) => !result.pass)).toEqual([]);
  });
});
