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
  | 'controlHover'
  | 'shadowColor';

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
  {token: 'successBg', cssVar: '--mndw-success-bg'},
  {token: 'warning', cssVar: '--mndw-warning'},
  {token: 'warningBg', cssVar: '--mndw-warning-bg'},
  {token: 'info', cssVar: '--mndw-info'},
  {token: 'infoBg', cssVar: '--mndw-info-bg'},
  {token: 'focusRing', cssVar: '--mndw-focus-ring'},
  {token: 'surfaceHover', cssVar: '--mndw-surface-hover'},
  {token: 'controlHover', cssVar: '--mndw-control-hover'},
  {token: 'shadowColor', cssVar: '--mndw-shadow-color'},
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
  {fg: 'text', bg: 'surfaceRaised', min: 4.5},
  {fg: 'text', bg: 'surfaceHover', min: 4.5},
  {fg: 'text', bg: 'controlHover', min: 4.5},
  {fg: 'textSubtle', bg: 'surfaceRaised', min: 4.5},
  {fg: 'textMuted', bg: 'surfaceRaised', min: 4.5},
  {fg: 'border', bg: 'surfaceRaised', min: 3},
  {fg: 'focusRing', bg: 'surfaceRaised', min: 3},
  {fg: 'success', bg: 'successBg', min: 4.5},
  {fg: 'warning', bg: 'warningBg', min: 4.5},
  {fg: 'info', bg: 'infoBg', min: 4.5},
] as const;
