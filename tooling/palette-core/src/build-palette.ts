import {contrastRatio} from './contrast.js';
import {PALETTE_CONTRAST_PAIRS, type ThemeName, type TokenName} from './metadata.js';
import {nudgeHexForContrast, oklchOf, oklchToHex, rampBetween, shiftLightness, withAlpha} from './ramp.js';

export interface Seed {
  primary: string;
  danger: string;
  success?: string;
  warning?: string;
  info?: string;
  bg: Record<ThemeName, string>;
  text: Record<ThemeName, string>;
  steps: number;
}

export const SEED: Seed = {
  primary: '#016ca5',
  danger: '#c5001b',
  bg: {dark: '#030405', light: '#f7fcfd'},
  text: {dark: '#eaf3fb', light: '#0c1217'},
  steps: 12,
};

export const PAIRS = PALETTE_CONTRAST_PAIRS;

function enforceContrast(palette: Record<TokenName, string>): void {
  const nudge = (token: TokenName, against: TokenName, min: number): void => {
    if (contrastRatio(palette[token], palette[against]) < min) {
      palette[token] = nudgeHexForContrast(palette[token], palette[against], min);
    }
  };

  nudge('surfaceRaised', 'text', 4.5);
  nudge('surfaceHover', 'text', 4.5);

  const worseSurface = (token: TokenName): TokenName =>
    contrastRatio(palette[token], palette.surface) <= contrastRatio(palette[token], palette.surfaceRaised)
      ? 'surface'
      : 'surfaceRaised';

  nudge('textMuted', worseSurface('textMuted'), 4.5);
  nudge('textSubtle', worseSurface('textSubtle'), 4.5);
  nudge('border', worseSurface('border'), 3);
  nudge('focusRing', 'surfaceRaised', 3);
  nudge('dangerBg', 'danger', 4.5);
  nudge('successBg', 'success', 4.5);
  nudge('warningBg', 'warning', 4.5);
  nudge('infoBg', 'info', 4.5);
}

export function buildPalette(theme: ThemeName, seed: Seed = SEED): Record<TokenName, string> {
  const neutral = rampBetween(seed.bg[theme], seed.text[theme], seed.steps);
  const bg = neutral[0];
  const surfaceShift = theme === 'dark' ? {surface: 0.06, raised: 0.1} : {surface: -0.03, raised: -0.015};
  const surface = shiftLightness(bg, surfaceShift.surface);
  const surfaceRaised = shiftLightness(bg, surfaceShift.raised);
  const border = neutral[5];
  const textSubtle = neutral[9];
  const textMuted = neutral[10];
  const text = neutral[seed.steps - 1];
  const accent = seed.primary;
  const accentHover = shiftLightness(accent, theme === 'dark' ? 0.08 : -0.08);
  const accentContrast = contrastRatio('#ffffff', accent) >= contrastRatio('#111111', accent) ? '#ffffff' : '#111111';
  const danger = seed.danger;
  const dangerHue = oklchOf(danger);
  const dangerBg = oklchToHex(theme === 'dark' ? 0.22 : 0.95, dangerHue.c * 0.4, dangerHue.h);
  const success = seed.success ?? oklchToHex(theme === 'dark' ? 0.7 : 0.5, 0.13, 150);
  const successHue = oklchOf(success);
  const successBg = oklchToHex(theme === 'dark' ? 0.22 : 0.95, successHue.c * 0.4, successHue.h);
  const warning = seed.warning ?? oklchToHex(theme === 'dark' ? 0.78 : 0.62, 0.15, 75);
  const warningHue = oklchOf(warning);
  const warningBg = oklchToHex(theme === 'dark' ? 0.22 : 0.95, warningHue.c * 0.4, warningHue.h);
  const info = seed.info ?? seed.primary;
  const infoHue = oklchOf(info);
  const infoBg = oklchToHex(theme === 'dark' ? 0.22 : 0.95, infoHue.c * 0.4, infoHue.h);
  const focusRing = shiftLightness(accent, theme === 'dark' ? 0.1 : -0.1);
  const surfaceHover = shiftLightness(surfaceRaised, theme === 'dark' ? 0.04 : -0.03);
  const shadowColor = withAlpha(shiftLightness(bg, theme === 'dark' ? -0.02 : -0.6), theme === 'dark' ? 0.55 : 0.18);

  const palette: Record<TokenName, string> = {
    bg,
    surface,
    surfaceRaised,
    border,
    textSubtle,
    textMuted,
    text,
    accent,
    accentHover,
    accentContrast,
    danger,
    dangerBg,
    success,
    successBg,
    warning,
    warningBg,
    info,
    infoBg,
    focusRing,
    surfaceHover,
    shadowColor,
  };

  enforceContrast(palette);

  return palette;
}

export function validatePalette(
  palette: Record<TokenName, string>,
): {pair: string; ratio: number; min: number; pass: boolean}[] {
  return PAIRS.map((pair) => {
    const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);

    return {
      pair: `${pair.fg} on ${pair.bg}`,
      ratio: Math.round(ratio * 100) / 100,
      min: pair.min,
      pass: ratio >= pair.min,
    };
  });
}
