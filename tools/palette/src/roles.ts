import {contrastRatio} from './contrast.js';
import {nudgeHexForContrast, oklchOf, oklchToHex, rampBetween, shiftLightness} from './ramp.js';

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
  | 'warning';

// Base colors are given as HEX inputs; every other token is derived from them.
// `bg` and `text` are provided per theme; `primary`/`danger` stay constant so
// the brand reads the same across themes. `success`/`warning` are optional.
export interface Seed {
  primary: string;
  danger: string;
  success?: string;
  warning?: string;
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
const PAIRS: {fg: TokenName; bg: TokenName; min: number}[] = [
  {fg: 'text', bg: 'surface', min: 4.5},
  {fg: 'text', bg: 'bg', min: 4.5},
  {fg: 'textMuted', bg: 'surface', min: 4.5},
  {fg: 'textSubtle', bg: 'surface', min: 4.5},
  {fg: 'border', bg: 'surface', min: 3},
  {fg: 'accentContrast', bg: 'accent', min: 4.5},
  {fg: 'danger', bg: 'dangerBg', min: 4.5},
];

// Nudge failing derived tokens along their own hue until they clear the target.
// bg/text/primary/danger are user inputs and stay pinned; only derivatives move.
function enforceContrast(palette: Record<TokenName, string>): void {
  const fixups: {token: TokenName; against: TokenName; min: number}[] = [
    {token: 'textMuted', against: 'surface', min: 4.5},
    {token: 'textSubtle', against: 'surface', min: 4.5},
    {token: 'border', against: 'surface', min: 3},
    {token: 'dangerBg', against: 'danger', min: 4.5},
  ];

  for (const fix of fixups) {
    if (contrastRatio(palette[fix.token], palette[fix.against]) < fix.min) {
      palette[fix.token] = nudgeHexForContrast(palette[fix.token], palette[fix.against], fix.min);
    }
  }
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
  const warning = seed.warning ?? oklchToHex(theme === 'dark' ? 0.78 : 0.62, 0.15, 75);

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
    warning,
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
