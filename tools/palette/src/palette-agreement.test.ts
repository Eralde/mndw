import {describe, expect, it} from 'vitest';
import {PALETTE_CONTRAST_PAIRS, PALETTE_CSS_VARIABLES} from '@mndw/sdk/palette';
import {PAIRS, buildPalette} from './index.js';

describe('palette contract agreement', () => {
  it('uses one exhaustive token set in generator and SDK metadata', () => {
    expect(Object.keys(buildPalette('dark')).sort()).toEqual(
      PALETTE_CSS_VARIABLES.map((entry) => entry.token).sort(),
    );
  });

  it('keeps generator and SDK contrast pairs element-wise identical', () => {
    expect(PAIRS).toEqual(PALETTE_CONTRAST_PAIRS);
  });
});
