import type {OverlayService} from '@mndw/sdk';
import {afterEach, describe, expect, expectTypeOf, it, vi} from 'vitest';
import {
  LocaleController,
  type LocaleControllerOptions,
  MNDW_BAR_CHART_TAG,
  MNDW_BUTTON_TAG,
  MNDW_CHECKBOX_TAG,
  MNDW_COLUMN_MENU_TAG,
  MNDW_FIELD_TAG,
  MNDW_HEAT_STRIP_TAG,
  MNDW_INPUT_TAG,
  MNDW_LINE_CHART_TAG,
  MNDW_OPTION_TAG,
  MNDW_SCROLL_AREA_TAG,
  MNDW_SEGMENTED_TAG,
  MNDW_SEGMENT_TAG,
  MNDW_SELECT_PANEL_TAG,
  MNDW_SELECT_TAG,
  MNDW_SLIDER_TAG,
  MNDW_SPARKLINE_TAG,
  MNDW_SWITCH_TAG,
  MNDW_TABLE_TAG,
  MNDW_TABS_TAG,
  MNDW_TAB_PANEL_TAG,
  MNDW_TAB_TAG,
  MNDW_TEXTAREA_TAG,
  MNDW_TOOLTIP_TAG,
  MndwBarChart,
  type MndwButton,
  type MndwCheckbox,
  type MndwColumnMenu,
  MndwLineChart,
  type MndwOption,
  type MndwScrollArea,
  type MndwSelect,
  type MndwSelectPanel,
  type MndwTable,
  POPOVER_FLIP_ORDER,
  computePopoverCoords,
  computeTooltipCoords,
  defineMndwUi,
  formatSpeed,
  getMndwUiText,
  resolveSizing,
  setMndwUiLocale,
} from './index.js';
import {getOverlayProvider, setOverlayProvider} from './overlay.js';

afterEach(() => {
  setMndwUiLocale('en');
  setOverlayProvider(undefined);
});

const REGISTERED_TAGS = [
  MNDW_BUTTON_TAG,
  MNDW_LINE_CHART_TAG,
  MNDW_BAR_CHART_TAG,
  MNDW_HEAT_STRIP_TAG,
  MNDW_CHECKBOX_TAG,
  MNDW_FIELD_TAG,
  MNDW_INPUT_TAG,
  MNDW_OPTION_TAG,
  MNDW_SCROLL_AREA_TAG,
  MNDW_SELECT_PANEL_TAG,
  MNDW_SELECT_TAG,
  MNDW_SEGMENT_TAG,
  MNDW_SEGMENTED_TAG,
  MNDW_SLIDER_TAG,
  MNDW_SPARKLINE_TAG,
  MNDW_SWITCH_TAG,
  MNDW_TAB_PANEL_TAG,
  MNDW_TAB_TAG,
  MNDW_TABS_TAG,
  MNDW_TEXTAREA_TAG,
  MNDW_TOOLTIP_TAG,
  MNDW_TABLE_TAG,
  MNDW_COLUMN_MENU_TAG,
];

describe('defineMndwUi', () => {
  it('registers every element', () => {
    defineMndwUi();

    for (const tag of REGISTERED_TAGS) {
      expect(customElements.get(tag)).toBeDefined();
    }
  });

  it('types shipped custom elements by tag name', () => {
    expectTypeOf(document.querySelector('mndw-button')).toEqualTypeOf<MndwButton | null>();
    expectTypeOf(document.querySelector('mndw-checkbox')).toEqualTypeOf<MndwCheckbox | null>();
    expectTypeOf(document.querySelector('mndw-select')).toEqualTypeOf<MndwSelect | null>();
    expectTypeOf(document.querySelector('mndw-select-panel')).toEqualTypeOf<MndwSelectPanel | null>();
    expectTypeOf(document.querySelector('mndw-option')).toEqualTypeOf<MndwOption | null>();
    expectTypeOf(document.querySelector('mndw-scroll-area')).toEqualTypeOf<MndwScrollArea | null>();
    expectTypeOf(document.querySelector('mndw-line-chart')).toEqualTypeOf<MndwLineChart | null>();
    expectTypeOf(document.querySelector('mndw-bar-chart')).toEqualTypeOf<MndwBarChart | null>();
    expectTypeOf(document.querySelector('mndw-table')).toEqualTypeOf<MndwTable | null>();
    expectTypeOf(document.querySelector('mndw-column-menu')).toEqualTypeOf<MndwColumnMenu | null>();
  });

  it('exports chart contracts and formatting', () => {
    expect(MndwLineChart).toBeDefined();
    expect(MndwBarChart).toBeDefined();
    expect(LocaleController).toBeDefined();
    expectTypeOf<LocaleControllerOptions>().toEqualTypeOf<{applyLocale?: () => void}>();
    expect(formatSpeed(1500)).toBe('1.5 Kb/s');
  });

  it('is idempotent — the registry is page-global and cannot be redefined', () => {
    defineMndwUi();

    expect(() => defineMndwUi()).not.toThrow();
  });

  it('keeps an injected overlay when called again without one', () => {
    const service = {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as OverlayService;

    defineMndwUi({overlay: service});

    const injected = getOverlayProvider();

    defineMndwUi();

    expect(getOverlayProvider()).toBe(injected);
  });

  it('replaces the provider when a new overlay is supplied', () => {
    const first = {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as OverlayService;
    const second = {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as OverlayService;

    defineMndwUi({overlay: first});

    const before = getOverlayProvider();

    defineMndwUi({overlay: second});

    expect(getOverlayProvider()).not.toBe(before);
  });

  it('accepts an initial locale without changing the setter contract', () => {
    defineMndwUi({initialLocale: 'ru'});

    expect(getMndwUiText('select.placeholder')).toBe('Выберите…');
  });
});

describe('positioning exports', () => {
  it('publishes helpers for host overlay consumers', () => {
    expect(POPOVER_FLIP_ORDER).toEqual(['bottom-start', 'top-start', 'bottom-end', 'top-end']);
    expect(typeof computePopoverCoords).toBe('function');
    expect(typeof computeTooltipCoords).toBe('function');
    expect(typeof resolveSizing).toBe('function');
  });
});
