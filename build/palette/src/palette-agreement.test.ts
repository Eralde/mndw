import {describe, expect, it} from 'vitest';
import {
  PALETTE_CONTRAST_PAIRS as CORE_CONTRAST_PAIRS,
  PALETTE_CSS_VARIABLES as CORE_CSS_VARIABLES,
} from '@mndw/palette-core';
import {PALETTE_CONTRAST_PAIRS, PALETTE_CSS_VARIABLES} from '@mndw/sdk-internal/palette';
import {PAIRS, buildPalette} from './index.js';

describe('palette contract agreement', () => {
  it('uses one exhaustive token set in generator and SDK metadata', () => {
    expect(Object.keys(buildPalette('dark')).sort()).toEqual(
      PALETTE_CSS_VARIABLES.map((entry) => entry.token).sort(),
    );
  });

  it('keeps generator and SDK contrast pairs element-wise identical', () => {
    expect(PAIRS).toEqual(PALETTE_CONTRAST_PAIRS);
    expect(PAIRS).toEqual(CORE_CONTRAST_PAIRS);
  });

  it('keeps SDK metadata as a binding of palette-core metadata', () => {
    expect(PALETTE_CSS_VARIABLES).toEqual(CORE_CSS_VARIABLES);
  });
});
