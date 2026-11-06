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

const SURFACE_SHIFT = {
  dark: {surface: 0.06, raised: 0.1},
  light: {surface: -0.03, raised: -0.015},
} as const;

const STATUS_BG_LIGHTNESS = {dark: 0.22, light: 0.95} as const;
const STATUS_BG_CHROMA = 0.4;

const STATUS_DEFAULTS = {
  success: {c: 0.13, h: 150, l: {dark: 0.7, light: 0.5}},
  warning: {c: 0.15, h: 75, l: {dark: 0.78, light: 0.62}},
} as const;

const ACCENT_SHIFT = {
  hover: {dark: 0.08, light: -0.08},
  focus: {dark: 0.1, light: -0.1},
} as const;

const SURFACE_HOVER_SHIFT = {dark: 0.04, light: -0.03} as const;

const SHADOW = {
  shift: {dark: -0.02, light: -0.6},
  alpha: {dark: 0.55, light: 0.18},
} as const;

const TEXT_INDEX = {border: 5, textSubtle: 9, textMuted: 10} as const;

function statusBg(color: string, theme: ThemeName): string {
  const {c, h} = oklchOf(color);

  return oklchToHex(STATUS_BG_LIGHTNESS[theme], c * STATUS_BG_CHROMA, h);
}

function statusDefault(name: keyof typeof STATUS_DEFAULTS, theme: ThemeName): string {
  const {c, h, l} = STATUS_DEFAULTS[name];

  return oklchToHex(l[theme], c, h);
}

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
  nudge('danger', 'dangerBg', 4.5);
  nudge('success', 'successBg', 4.5);
  nudge('warning', 'warningBg', 4.5);
  nudge('info', 'infoBg', 4.5);
}

export function buildPalette(theme: ThemeName, seed: Seed = SEED): Record<TokenName, string> {
  const neutral = rampBetween(seed.bg[theme], seed.text[theme], seed.steps);
  const bg = neutral[0];
  const surface = shiftLightness(bg, SURFACE_SHIFT[theme].surface);
  const surfaceRaised = shiftLightness(bg, SURFACE_SHIFT[theme].raised);

  const border = neutral[TEXT_INDEX.border];
  const textSubtle = neutral[TEXT_INDEX.textSubtle];
  const textMuted = neutral[TEXT_INDEX.textMuted];
  const text = neutral[seed.steps - 1];

  const accent = seed.primary;
  const accentHover = shiftLightness(accent, ACCENT_SHIFT.hover[theme]);
  const accentContrast = contrastRatio('#ffffff', accent) >= contrastRatio('#111111', accent) ? '#ffffff' : '#111111';

  const danger = seed.danger;
  const dangerBg = statusBg(danger, theme);

  const success = seed.success ?? statusDefault('success', theme);
  const successBg = statusBg(success, theme);

  const warning = seed.warning ?? statusDefault('warning', theme);
  const warningBg = statusBg(warning, theme);

  const info = seed.info ?? seed.primary;
  const infoBg = statusBg(info, theme);

  const focusRing = shiftLightness(accent, ACCENT_SHIFT.focus[theme]);
  const surfaceHover = shiftLightness(surfaceRaised, SURFACE_HOVER_SHIFT[theme]);
  const shadowColor = withAlpha(shiftLightness(bg, SHADOW.shift[theme]), SHADOW.alpha[theme]);

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
