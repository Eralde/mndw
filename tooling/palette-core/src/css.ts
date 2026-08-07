import {PALETTE_CSS_VARIABLES, type PaletteTokenMap, type ThemeName} from './metadata.js';

export function paletteToCss(map: PaletteTokenMap, options: {selector?: string} = {}): string {
  const selector = options.selector ?? ':root';
  const block = (theme: ThemeName): string =>
    PALETTE_CSS_VARIABLES.map((entry) => `  ${entry.cssVar}: ${map[theme][entry.token]};`).join('\n');

  return `${selector},
${selector}[data-theme='dark'] {
${block('dark')}
}

${selector}[data-theme='light'] {
${block('light')}
}
`;
}
