import {describe, expect, it} from 'vitest';
import {contrastRatio} from './contrast.js';
import {SEED, buildPalette, deriveControlHover, validatePalette} from './build-palette.js';
import {oklchOf} from './ramp.js';

const statusPairs = [
  {foreground: 'danger', background: 'dangerBg'},
  {foreground: 'success', background: 'successBg'},
  {foreground: 'warning', background: 'warningBg'},
  {foreground: 'info', background: 'infoBg'},
] as const;

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

  it.each(['light', 'dark'] as const)('builds a readable control hover surface for %s', (theme) => {
    const palette = buildPalette(theme);

    expect(palette.controlHover).toMatch(/^#[0-9a-f]{6}$/u);
    expect(contrastRatio(palette.text, palette.controlHover)).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(oklchOf(palette.controlHover).l - oklchOf(palette.surface).l)).toBeGreaterThan(0.05);
    expect(Math.abs(oklchOf(palette.controlHover).l - oklchOf(palette.surface).l))
      .toBeGreaterThan(Math.abs(oklchOf(palette.surfaceHover).l - oklchOf(palette.surface).l));
    expect(deriveControlHover(palette.surface, palette.text, theme)).toBe(palette.controlHover);
  });

  it.each(['light', 'dark'] as const)('keeps %s status backgrounds on the theme side with readable pairs', (theme) => {
    const palette = buildPalette(theme);

    for (const {foreground, background} of statusPairs) {
      const lightness = oklchOf(palette[background]).l;

      if (theme === 'light') {
        expect(lightness, `${theme} ${background}`).toBeGreaterThanOrEqual(0.85);
      } else {
        expect(lightness, `${theme} ${background}`).toBeLessThanOrEqual(0.35);
      }

      expect(contrastRatio(palette[foreground], palette[background]), `${theme} ${foreground} on ${background}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['light', 'dark'] as const)(
    'keeps custom-seed %s status backgrounds on the theme side with readable pairs',
    (theme) => {
      const palette = buildPalette(theme, {...SEED, warning: '#e6c229'});

      for (const {foreground, background} of statusPairs) {
        const lightness = oklchOf(palette[background]).l;

        if (theme === 'light') {
          expect(lightness, `${theme} ${background}`).toBeGreaterThanOrEqual(0.85);
        } else {
          expect(lightness, `${theme} ${background}`).toBeLessThanOrEqual(0.35);
        }

        expect(contrastRatio(palette[foreground], palette[background]), `${theme} ${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('keeps the default light warning background pale', () => {
    expect(oklchOf(buildPalette('light').warningBg).l).toBeGreaterThanOrEqual(0.85);
  });
});
