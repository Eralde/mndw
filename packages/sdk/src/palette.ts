/**
 * Palette metadata, validation, WCAG contrast math, and CSS rendering.
 *
 * Pure and browser-safe: no DOM access, no imports from the generated `tokens.ts`.
 */

export type ThemeName = 'dark' | 'light';

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

export type PaletteTokenMap = Record<ThemeName, Record<TokenName, string>>;

export interface PaletteCssVariable {
  token: TokenName;
  cssVar: string;
}

export const PALETTE_CSS_VARIABLES: readonly PaletteCssVariable[] = [
  {token: 'bg', cssVar: '--mndw-bg'},
  {token: 'surface', cssVar: '--mndw-surface'},
  {token: 'surfaceRaised', cssVar: '--mndw-surface-raised'},
  {token: 'border', cssVar: '--mndw-border'},
  {token: 'textSubtle', cssVar: '--mndw-text-subtle'},
  {token: 'textMuted', cssVar: '--mndw-text-muted'},
  {token: 'text', cssVar: '--mndw-text'},
  {token: 'accent', cssVar: '--mndw-accent'},
  {token: 'accentHover', cssVar: '--mndw-accent-hover'},
  {token: 'accentContrast', cssVar: '--mndw-accent-contrast'},
  {token: 'danger', cssVar: '--mndw-danger'},
  {token: 'dangerBg', cssVar: '--mndw-danger-bg'},
  {token: 'success', cssVar: '--mndw-success'},
  {token: 'warning', cssVar: '--mndw-warning'},
] as const;

export interface PaletteContrastPair {
  fg: TokenName;
  bg: TokenName;
  min: number;
}

export const PALETTE_CONTRAST_PAIRS: readonly PaletteContrastPair[] = [
  {fg: 'text', bg: 'surface', min: 4.5},
  {fg: 'text', bg: 'bg', min: 4.5},
  {fg: 'textMuted', bg: 'surface', min: 4.5},
  {fg: 'textSubtle', bg: 'surface', min: 4.5},
  {fg: 'border', bg: 'surface', min: 3},
  {fg: 'accentContrast', bg: 'accent', min: 4.5},
  {fg: 'danger', bg: 'dangerBg', min: 4.5},
] as const;

export interface PaletteContrastWarning {
  theme: ThemeName;
  pair: string;
  ratio: number;
  min: number;
}

export interface PaletteValidation {
  palette: PaletteTokenMap | null;
  structuralErrors: string[];
  contrastWarnings: PaletteContrastWarning[];
}

const THEMES: readonly ThemeName[] = ['dark', 'light'] as const;
const TOKENS: readonly TokenName[] = PALETTE_CSS_VARIABLES.map((entry) => entry.token);
const HEX_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hexToChannels(hex: string): [number, number, number] {
  const normalized = hex.slice(1);
  const value = normalized.length === 3
    ? normalized.split('').map((channel) => channel + channel)
      .join('')
    : normalized;

  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function linearize(channel: number): number {
  const c = channel / 255;

  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToChannels(hex);

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

function validateTheme(input: unknown, theme: ThemeName, errors: string[]): boolean {
  if (!isPlainObject(input)) {
    errors.push(`"${theme}" must be an object of 14 colour tokens.`);

    return false;
  }

  let ok = true;

  for (const token of TOKENS) {
    const value = input[token];

    if (value === undefined) {
      errors.push(`"${theme}" is missing the token "${token}".`);
      ok = false;

      continue;
    }

    if (typeof value !== 'string') {
      errors.push(`"${theme}.${token}" must be a string, got ${typeof value}.`);
      ok = false;

      continue;
    }

    if (!HEX_PATTERN.test(value)) {
      errors.push(`"${theme}.${token}" must be a hex colour like #1a2b3c, got "${value}".`);
      ok = false;
    }
  }

  for (const key of Object.keys(input)) {
    if (!(TOKENS as readonly string[]).includes(key)) {
      errors.push(`"${theme}" has an unknown token "${key}".`);
      ok = false;
    }
  }

  return ok;
}

function collectWarnings(map: PaletteTokenMap): PaletteContrastWarning[] {
  const warnings: PaletteContrastWarning[] = [];

  for (const theme of THEMES) {
    for (const pair of PALETTE_CONTRAST_PAIRS) {
      const ratio = contrastRatio(map[theme][pair.fg], map[theme][pair.bg]);

      if (ratio < pair.min) {
        warnings.push({
          theme,
          pair: `${pair.fg} on ${pair.bg}`,
          ratio: Number(ratio.toFixed(2)),
          min: pair.min,
        });
      }
    }
  }

  return warnings;
}

export function validateImportedPalette(input: unknown): PaletteValidation {
  const structuralErrors: string[] = [];

  if (!isPlainObject(input)) {
    return {
      palette: null,
      structuralErrors: ['The file must contain a JSON object with "dark" and "light" keys.'],
      contrastWarnings: [],
    };
  }

  let ok = true;

  for (const theme of THEMES) {
    if (!(theme in input)) {
      structuralErrors.push(`Missing the "${theme}" theme.`);
      ok = false;

      continue;
    }

    if (!validateTheme(input[theme], theme, structuralErrors)) {
      ok = false;
    }
  }

  for (const key of Object.keys(input)) {
    if (!(THEMES as readonly string[]).includes(key)) {
      structuralErrors.push(`Unknown top-level key "${key}"; expected only "dark" and "light".`);
      ok = false;
    }
  }

  if (!ok) {
    return {palette: null, structuralErrors, contrastWarnings: []};
  }

  const palette = {
    dark: {} as Record<TokenName, string>,
    light: {} as Record<TokenName, string>,
  };

  for (const theme of THEMES) {
    const source = input[theme] as Record<string, string>;

    for (const token of TOKENS) {
      palette[theme][token] = source[token];
    }
  }

  return {palette, structuralErrors: [], contrastWarnings: collectWarnings(palette)};
}

export function paletteToCss(map: PaletteTokenMap, options: {selector?: string} = {}): string {
  const selector = options.selector ?? ':root';
  const block = (theme: ThemeName): string =>
    PALETTE_CSS_VARIABLES
      .map((entry) => `  ${entry.cssVar}: ${map[theme][entry.token]};`)
      .join('\n');

  return `${selector},
${selector}[data-theme='dark'] {
${block('dark')}
}

${selector}[data-theme='light'] {
${block('light')}
}
`;
}
