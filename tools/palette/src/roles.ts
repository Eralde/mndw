import {contrastRatio} from './contrast.js';
import {nudgeHexForContrast, oklchOf, oklchToHex, rampBetween, shiftLightness, withAlpha} from './ramp.js';

export type ThemeName = 'light' | 'dark';

export type TokenName =
  | 'bg'
  | 'surface'
  | 'surfaceRaised'
  | 'border'
  | 'textSubtle'
  | 'textMuted'
  | 'text'
  | 'accent'
  | 'accentHover'
  | 'accentContrast'
  | 'danger'
  | 'dangerBg'
  | 'success'
  | 'successBg'
  | 'warning'
  | 'warningBg'
  | 'info'
  | 'infoBg'
  | 'focusRing'
  | 'surfaceHover'
  | 'shadowColor';

// Base colors are given as HEX inputs; every other token is derived from them.
// `bg` and `text` are provided per theme; `primary`/`danger` stay constant so
// the brand reads the same across themes. `success`/`warning`/`info` are optional.
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

// Single source of truth. Tune these in the playground, then commit.
export const SEED: Seed = {
  primary: '#016ca5',
  danger: '#c5001b',
  bg: {dark: '#030405', light: '#f7fcfd'},
  text: {dark: '#eaf3fb', light: '#0c1217'},
  steps: 12,
};

// Contrast targets per semantic pairing.
export const PAIRS: {fg: TokenName; bg: TokenName; min: number}[] = [
  {fg: 'text', bg: 'surface', min: 4.5},
  {fg: 'text', bg: 'bg', min: 4.5},
  {fg: 'textMuted', bg: 'surface', min: 4.5},
  {fg: 'textSubtle', bg: 'surface', min: 4.5},
  {fg: 'border', bg: 'surface', min: 3},
  {fg: 'accentContrast', bg: 'accent', min: 4.5},
  {fg: 'danger', bg: 'dangerBg', min: 4.5},
  {fg: 'text', bg: 'surfaceRaised', min: 4.5},
  {fg: 'text', bg: 'surfaceHover', min: 4.5},
  {fg: 'textSubtle', bg: 'surfaceRaised', min: 4.5},
  {fg: 'textMuted', bg: 'surfaceRaised', min: 4.5},
  {fg: 'border', bg: 'surfaceRaised', min: 3},
  {fg: 'focusRing', bg: 'surfaceRaised', min: 3},
  {fg: 'success', bg: 'successBg', min: 4.5},
  {fg: 'warning', bg: 'warningBg', min: 4.5},
  {fg: 'info', bg: 'infoBg', min: 4.5},
];

// Nudge failing derived tokens along their own hue until they clear the target.
// bg/text/primary/danger are user inputs and stay pinned; only derivatives move.
function enforceContrast(palette: Record<TokenName, string>): void {
  const nudge = (token: TokenName, against: TokenName, min: number): void => {
    if (contrastRatio(palette[token], palette[against]) < min) {
      palette[token] = nudgeHexForContrast(palette[token], palette[against], min);
    }
  };

  // Pass 1: settle derivative surfaces against pinned body text.
  nudge('surfaceRaised', 'text', 4.5);
  nudge('surfaceHover', 'text', 4.5);

  // Pass 2: settle foreground derivatives against whichever surface is harder
  // for them to read, then settle each status background against its foreground.
  const worseSurface = (token: TokenName): TokenName =>
    contrastRatio(palette[token], palette.surface)
        <= contrastRatio(palette[token], palette.surfaceRaised)
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
  // Neutral ramp interpolates from the theme's bg to its text, endpoints pinned.
  const neutral = rampBetween(seed.bg[theme], seed.text[theme], seed.steps);
  const bg = neutral[0];
  // Surfaces are small lightness shifts off bg, not full ramp steps, so a very
  // dark text endpoint doesn't drag light-theme panels to grey. Dark: lighter
  // (raised = higher). Light: kept close to the near-white bg, raised nearer bg.
  const surfaceShift = theme === 'dark' ? {surface: 0.06, raised: 0.1} : {surface: -0.03, raised: -0.015};
  const surface = shiftLightness(bg, surfaceShift.surface);
  const surfaceRaised = shiftLightness(bg, surfaceShift.raised);
  const border = neutral[5];
  const textSubtle = neutral[9];
  const textMuted = neutral[10];
  const text = neutral[seed.steps - 1];

  // Brand primary is pinned exactly. Hover shifts lightness toward the theme's
  // foreground: lighter on dark, darker on light.
  const accent = seed.primary;
  const accentHover = shiftLightness(accent, theme === 'dark' ? 0.08 : -0.08);
  const accentContrast = contrastRatio('#ffffff', accent) >= contrastRatio('#111111', accent)
    ? '#ffffff'
    : '#111111';

  // Danger is pinned; its tinted background is derived from the danger hue.
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
  const shadowColor = withAlpha(
    shiftLightness(bg, theme === 'dark' ? -0.02 : -0.6),
    theme === 'dark' ? 0.55 : 0.18,
  );

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
