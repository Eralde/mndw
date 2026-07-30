import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {SCALE} from './scale.js';

const generatedCss = new URL('../../../packages/sdk/src/tokens.css', import.meta.url);
const generatedTs = new URL('../../../packages/sdk/src/tokens.ts', import.meta.url);
const scrollAreaSource = new URL('../../../packages/ui/src/scroll-area/scroll-area.ts', import.meta.url);
const selectPanelSource = new URL('../../../packages/ui/src/select/select-panel.ts', import.meta.url);
const baseSource = new URL('../../../packages/ui/src/styles/base.ts', import.meta.url);

describe('SCALE', () => {
  it('contains typed Layer B values and legacy static values', () => {
    expect(SCALE.font).toEqual({
      sans: '-apple-system, \'BlinkMacSystemFont\', \'Segoe UI\', \'Roboto\', sans-serif',
      mono: 'ui-monospace, \'SF Mono\', \'Menlo\', monospace',
    });
    expect(SCALE.text).toEqual({xs: '11px', sm: '13px', md: '14px', lg: '16px'});
    expect(SCALE.leading).toBe('1.4');
    expect(SCALE.weight).toEqual({normal: '400', semibold: '600'});
    expect(SCALE.space).toEqual({1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px'});
    expect(SCALE.radius).toEqual({sm: '3px', md: '6px', lg: '8px'});
  });

  it('contains shared control and component geometry', () => {
    expect(SCALE.control).toEqual({base: '32px', sm: '28px', lg: '40px'});
    expect(SCALE.border).toEqual({width: '1px', focusWidth: '2px'});
    expect(SCALE.motion).toEqual({fast: '120ms', base: '180ms', easing: 'ease'});
    expect(SCALE.scrollbar).toEqual({size: '10px', radius: '6px', thumbMinSize: '24px'});
    expect(SCALE.switch).toEqual({width: '36px', height: '20px'});
    expect(SCALE.slider).toEqual({trackHeight: '4px', thumbSize: '16px'});
    expect(SCALE.table).toEqual({stickyTop: '0px'});
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
        '--mndw-scrollbar-size: 10px;',
        '--mndw-scrollbar-radius: 6px;',
        '--mndw-scrollbar-thumb-min-size: 24px;',
        '--mndw-scrollbar-track: var(--mndw-surface);',
        '--mndw-scrollbar-thumb: var(--mndw-accent);',
        '--mndw-scrollbar-thumb-hover: var(--mndw-accent-hover);',
        '--mndw-shadow-1: 0 1px 2px var(--mndw-shadow-color);',
        '--mndw-shadow-2: 0 8px 24px var(--mndw-shadow-color);',
        '--mndw-border-w: 1px;',
        '--mndw-focus-w: 2px;',
        '--mndw-control-h-sm: 28px;',
        '--mndw-control-h-lg: 40px;',
        '--mndw-duration-fast: 120ms;',
        '--mndw-easing: ease;',
        '--mndw-switch-w: 36px;',
        '--mndw-switch-h: 20px;',
        '--mndw-slider-track-h: 4px;',
        '--mndw-slider-thumb-size: 16px;',
        '--mndw-table-sticky-top: 0px;',
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
