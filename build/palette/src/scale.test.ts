import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {SCALE} from './scale.js';

const generatedCss = new URL('../../../frontend/sdk/src/tokens.css', import.meta.url);
const generatedTs = new URL('../../../frontend/sdk/src/tokens.ts', import.meta.url);
const scrollAreaSource = new URL('../../../frontend/ui/src/scroll-area/scroll-area.ts', import.meta.url);
const selectPanelSource = new URL('../../../frontend/ui/src/select/select-panel.ts', import.meta.url);
const baseSource = new URL('../../../frontend/ui/src/styles/base.ts', import.meta.url);

describe('SCALE', () => {
  it('contains typed Layer B values and legacy static values', () => {
    expect(SCALE.font).toEqual({
      sans: '-apple-system, \'BlinkMacSystemFont\', \'Segoe UI\', \'Roboto\', sans-serif',
      mono: 'ui-monospace, \'SF Mono\', \'Menlo\', monospace',
    });
    expect(SCALE.text).toEqual({xs: '0.6875rem', sm: '0.8125rem', md: '0.875rem', lg: '1rem'});
    expect(SCALE.leading).toBe('1.4');
    expect(SCALE.weight).toEqual({normal: '400', semibold: '600'});
    expect(SCALE.space).toEqual({1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem', 5: '1.5rem', 6: '2rem'});
    expect(SCALE.radius).toEqual({sm: '0.1875rem', md: '0.375rem', lg: '0.5rem'});
  });

  it('contains shared control and component geometry', () => {
    expect(SCALE.control).toEqual({base: '2rem', sm: '1.75rem', lg: '2.5rem'});
    expect(SCALE.border).toEqual({width: '1px', focusWidth: '2px'});
    expect(SCALE.motion).toEqual({fast: '120ms', base: '180ms', easing: 'ease'});
    expect(SCALE.scrollbar).toEqual({size: '0.625rem', radius: '0.375rem', thumbMinSize: '1.5rem'});
    expect(SCALE.switch).toEqual({width: '2.25rem', height: '1.25rem'});
    expect(SCALE.slider).toEqual({trackHeight: '0.25rem', thumbSize: '1rem'});
    expect(SCALE.table).toEqual({stickyTop: '0'});
  });

  it('keeps shadow aliases centralized for generated output', () => {
    expect(SCALE.aliases).toEqual({
      scrollbarTrack: 'var(--mndw-surface)',
      scrollbarThumb: 'var(--mndw-accent)',
      scrollbarThumbHover: 'var(--mndw-accent-hover)',
      shadow1: '0 1px 2px var(--mndw-shadow-color)',
      shadow2: '0 8px 24px var(--mndw-shadow-color)',
    });
  });

  it('emits every Layer B token and exports the scale map', async () => {
    const css = await readFile(generatedCss, 'utf8');
    const ts = await readFile(generatedTs, 'utf8');

    for (
      const declaration of [
        '--mndw-scrollbar-size: 0.625rem;',
        '--mndw-scrollbar-radius: 0.375rem;',
        '--mndw-scrollbar-thumb-min-size: 1.5rem;',
        '--mndw-scrollbar-track: var(--mndw-surface);',
        '--mndw-scrollbar-thumb: var(--mndw-accent);',
        '--mndw-scrollbar-thumb-hover: var(--mndw-accent-hover);',
        '--mndw-shadow-1: 0 1px 2px var(--mndw-shadow-color);',
        '--mndw-shadow-2: 0 8px 24px var(--mndw-shadow-color);',
        '--mndw-border-w: 1px;',
        '--mndw-focus-w: 2px;',
        '--mndw-control-h-sm: 1.75rem;',
        '--mndw-control-h-lg: 2.5rem;',
        '--mndw-duration-fast: 120ms;',
        '--mndw-easing: ease;',
        '--mndw-switch-w: 2.25rem;',
        '--mndw-switch-h: 1.25rem;',
        '--mndw-slider-track-h: 0.25rem;',
        '--mndw-slider-thumb-size: 1rem;',
        '--mndw-table-sticky-top: 0;',
      ]
    ) {
      expect(css).toContain(declaration);
    }

    expect(ts).toContain('export const MNDW_SCALE =');
  });

  it('has no token fallbacks or fixed sheet cap in migrated UI sources', async () => {
    const [scrollArea, selectPanel, base] = await Promise.all([
      readFile(scrollAreaSource, 'utf8'),
      readFile(selectPanelSource, 'utf8'),
      readFile(baseSource, 'utf8'),
    ]);

    expect(scrollArea).not.toMatch(/var\(--mndw-scrollbar-(?:size|radius|track|thumb|thumb-hover|thumb-min-size),/);
    expect(selectPanel).not.toMatch(/var\(--mndw-(?:scrollbar-size|select-sheet-max-height),/);
    expect(selectPanel).not.toContain('54px');
    expect(base).not.toContain('outline: 2px solid var(--mndw-accent)');
  });
});
