import {describe, expect, it} from 'vitest';
import {contrastRatio} from './contrast.js';
import {buildPalette, validatePalette} from './roles.js';

describe('buildPalette', () => {
  it('produces every semantic token for both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const p = buildPalette(theme);

      for (
        const key of [
          'bg',
          'surface',
          'surfaceRaised',
          'border',
          'textSubtle',
          'textMuted',
          'text',
          'accent',
          'accentHover',
          'accentContrast',
          'danger',
          'dangerBg',
          'success',
          'warning',
        ] as const
      ) {
        expect(p[key], `${theme}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('validatePalette (WCAG gate)', () => {
  it('every semantic pairing passes its target in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const results = validatePalette(buildPalette(theme));
      const failures = results.filter((r) => !r.pass);

      expect(failures, `${theme}: ${JSON.stringify(failures)}`).toEqual([]);
    }
  });

  it('body text clears 4.5:1 on surface in dark theme', () => {
    const p = buildPalette('dark');

    expect(contrastRatio(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
