import {describe, expect, it} from 'vitest';
import {contrastRatio} from './contrast.js';
import {
  buildRamp,
  nudgeForContrast,
  nudgeHexForContrast,
  oklchOf,
  oklchToHex,
  rampBetween,
  shiftLightness,
} from './ramp.js';

describe('oklchToHex', () => {
  it('returns a 7-char hex string', () => {
    expect(oklchToHex(0.6, 0.15, 280)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('produces in-gamut colors even at high chroma', () => {
    // Unclamped this chroma is outside sRGB; clamped output must still parse.
    expect(oklchToHex(0.9, 0.4, 140)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('buildRamp', () => {
  it('returns one hex per step', () => {
    const ramp = buildRamp({hue: 280, chroma: 0.05, steps: 12, lMin: 0.12, lMax: 0.98});

    expect(ramp).toHaveLength(12);
    expect(ramp.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });

  it('increases in luminance from first to last step', () => {
    const ramp = buildRamp({hue: 280, chroma: 0.05, steps: 12, lMin: 0.12, lMax: 0.98});

    expect(contrastRatio(ramp[0], '#000000')).toBeLessThan(contrastRatio(ramp[11], '#000000'));
  });
});

describe('nudgeForContrast', () => {
  it('walks lightness until the target ratio is met', () => {
    // Start too dark against a dark background; must lighten until >= 4.5.
    const bg = '#1a1a2e';
    const result = nudgeForContrast({hue: 280, chroma: 0.02, l: 0.2, bgHex: bg, target: 4.5});

    expect(contrastRatio(result, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('oklchOf / shiftLightness', () => {
  it('round-trips a hex through OKLCH within tolerance', () => {
    const {l, c, h} = oklchOf('#007bbe');

    expect(oklchToHex(l, c, h)).toBe('#007bbe');
  });

  it('lightens on positive delta, darkens on negative', () => {
    const base = '#4a4a55';

    expect(contrastRatio(shiftLightness(base, 0.15), '#000000'))
      .toBeGreaterThan(contrastRatio(base, '#000000'));
    expect(contrastRatio(shiftLightness(base, -0.15), '#000000'))
      .toBeLessThan(contrastRatio(base, '#000000'));
  });
});

describe('rampBetween', () => {
  it('pins the exact endpoints and fills interior steps', () => {
    const ramp = rampBetween('#050a0f', '#eaf3fb', 12);

    expect(ramp).toHaveLength(12);
    expect(ramp[0]).toBe('#050a0f');
    expect(ramp[11]).toBe('#eaf3fb');
    expect(ramp.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(contrastRatio(ramp[0], '#000000')).toBeLessThan(contrastRatio(ramp[11], '#000000'));
  });
});

describe('nudgeHexForContrast', () => {
  it('preserves hue while clearing the target', () => {
    const bg = '#0d1b12';
    const result = nudgeHexForContrast('#1f6b3a', bg, 4.5);

    expect(contrastRatio(result, bg)).toBeGreaterThanOrEqual(4.5);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });
});
