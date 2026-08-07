/**
 * Palette validation and SDK-facing exports.
 *
 * Palette math and metadata live in the dependency-free TypeScript substrate
 * so SDK and build tooling consume one implementation.
 */

import {
  PALETTE_CONTRAST_PAIRS,
  PALETTE_CSS_VARIABLES,
  type PaletteContrastPair,
  type PaletteCssVariable,
  type PaletteTokenMap,
  type ThemeName,
  type TokenName,
  contrastRatio,
  paletteToCss,
} from '@mndw/palette-core';

export {contrastRatio, PALETTE_CONTRAST_PAIRS, PALETTE_CSS_VARIABLES, paletteToCss};
export type {PaletteContrastPair, PaletteCssVariable, PaletteTokenMap, ThemeName, TokenName};

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

function validateTheme(input: unknown, theme: ThemeName, errors: string[]): boolean {
  if (!isPlainObject(input)) {
    errors.push(`"${theme}" must be an object of 21 colour tokens.`);

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
