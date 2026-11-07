import {describe, expect, it} from 'vitest';
import {PALETTE_CONTRAST_PAIRS, PALETTE_CSS_VARIABLES} from './metadata.js';

describe('palette metadata', () => {
  it('maps every token to one CSS variable', () => {
    expect(PALETTE_CSS_VARIABLES).toHaveLength(22);
    expect(new Set(PALETTE_CSS_VARIABLES.map((entry) => entry.token)).size).toBe(22);
    expect(PALETTE_CSS_VARIABLES.find((entry) => entry.token === 'surfaceRaised')?.cssVar)
      .toBe('--mndw-surface-raised');
    expect(PALETTE_CSS_VARIABLES.find((entry) => entry.token === 'controlHover')?.cssVar)
      .toBe('--mndw-control-hover');
  });

  it('references only known tokens in contrast pairs', () => {
    const names = new Set(PALETTE_CSS_VARIABLES.map((entry) => entry.token));

    for (const pair of PALETTE_CONTRAST_PAIRS) {
      expect(names.has(pair.fg)).toBe(true);
      expect(names.has(pair.bg)).toBe(true);
    }
  });
});
