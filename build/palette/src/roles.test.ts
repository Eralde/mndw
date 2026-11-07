import {describe, expect, it} from 'vitest';
import {contrastRatio} from './contrast.js';
import {oklchOf} from './ramp.js';
import {PAIRS, SEED, buildPalette, validatePalette} from './roles.js';

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
          'successBg',
          'warning',
          'warningBg',
          'info',
          'infoBg',
          'focusRing',
          'surfaceHover',
          'shadowColor',
        ] as const
      ) {
        expect(p[key], `${theme}.${key}`).toMatch(key === 'shadowColor' ? /^#[0-9a-f]{8}$/ : /^#[0-9a-f]{6}$/);
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

  it('exports all contrast pairs, including new status and surface relationships', () => {
    expect(PAIRS).toHaveLength(17);
    expect(PAIRS).toEqual(expect.arrayContaining([
      {fg: 'text', bg: 'surfaceRaised', min: 4.5},
      {fg: 'text', bg: 'surfaceHover', min: 4.5},
      {fg: 'text', bg: 'controlHover', min: 4.5},
      {fg: 'focusRing', bg: 'surfaceRaised', min: 3},
      {fg: 'success', bg: 'successBg', min: 4.5},
      {fg: 'warning', bg: 'warningBg', min: 4.5},
      {fg: 'info', bg: 'infoBg', min: 4.5},
    ]));
  });

  it('keeps passing info seeds and adjusts dark info for its dark background', () => {
    const lightDefault = buildPalette('light');
    const darkDefault = buildPalette('dark');
    const lightCustom = buildPalette('light', {...SEED, info: '#7a3fb3'});

    expect(lightDefault.info).toBe(SEED.primary);
    expect(lightCustom.info).toBe('#7a3fb3');
    expect(darkDefault.info).not.toBe(SEED.primary);
    expect(contrastRatio(darkDefault.info, darkDefault.infoBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps raised surfaces visibly lighter than surfaces', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = buildPalette(theme);

      expect(oklchOf(palette.surfaceRaised).l - oklchOf(palette.surface).l).toBeGreaterThanOrEqual(0.012);
    }
  });

  it('keeps shadow color hex-shaped and outside contrast validation', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(buildPalette(theme).shadowColor).toMatch(/^#[0-9a-f]{8}$/);
    }

    expect(PAIRS.some(({fg, bg}) => fg === 'shadowColor' || bg === 'shadowColor')).toBe(false);
  });
});
