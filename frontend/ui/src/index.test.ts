// @vitest-environment happy-dom
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
  type MndwBarChartProps,
  type MndwButton,
  type MndwChartDomain,
  type MndwChartPoint,
  type MndwChartSample,
  type MndwChartSeries,
  type MndwChartTooltipContent,
  type MndwChartTooltipContext,
  type MndwChartTooltipFormatter,
  type MndwChartTooltipSample,
  type MndwChartValueFormatter,
  type MndwCheckbox,
  type MndwColumnMenu,
  MndwHeatStrip,
  type MndwHeatStripProps,
  type MndwIconName,
  MndwLineChart,
  type MndwLineChartProps,
  type MndwOption,
  type MndwScrollArea,
  type MndwSelect,
  type MndwSelectPanel,
  MndwSparkline,
  type MndwSparklineProps,
  type MndwTable,
  POPOVER_FLIP_ORDER,
  computePopoverCoords,
  computeTooltipCoords,
  createFocusTrap,
  defineMndwUi,
  formatSpeed,
  getMndwUiText,
  mndwIconHref,
  resolveSizing,
  setMndwUiLocale,
  subscribeMndwIconSprite,
  tabbableElements,
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
    expectTypeOf(document.querySelector('mndw-sparkline')).toEqualTypeOf<MndwSparkline | null>();
    expectTypeOf(document.querySelector('mndw-heat-strip')).toEqualTypeOf<MndwHeatStrip | null>();
    expectTypeOf(document.querySelector('mndw-table')).toEqualTypeOf<MndwTable | null>();
    expectTypeOf(document.querySelector('mndw-column-menu')).toEqualTypeOf<MndwColumnMenu | null>();
  });

  it('exports chart contracts and formatting', () => {
    expect(MndwLineChart).toBeDefined();
    expect(MndwBarChart).toBeDefined();
    expect(MndwSparkline).toBeDefined();
    expect(MndwHeatStrip).toBeDefined();
    expect(LocaleController).toBeDefined();
    expectTypeOf<LocaleControllerOptions>().toEqualTypeOf<{applyLocale?: () => void}>();
    expect(formatSpeed(1500)).toBe('1.5 Kb/s');
    expectTypeOf<MndwChartSample>().toMatchTypeOf<{value: number; time?: number}>();
    expectTypeOf<MndwBarChartProps['valueFormatter']>()
      .toEqualTypeOf<MndwChartValueFormatter | undefined>();
    expectTypeOf<MndwSparklineProps['points']>().toEqualTypeOf<readonly MndwChartSample[] | undefined>();
    expectTypeOf<MndwSparklineProps['timeDomain']>().toEqualTypeOf<MndwChartDomain | undefined>();
    expectTypeOf<MndwBarChartProps['points']>().toEqualTypeOf<readonly MndwChartPoint[] | undefined>();
    expectTypeOf<MndwLineChartProps['series']>().toEqualTypeOf<readonly MndwChartSeries[] | undefined>();
    expectTypeOf<MndwHeatStripProps['max']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<MndwSparklineProps>().not.toHaveProperty('values');
    expectTypeOf<MndwSparklineProps>().not.toHaveProperty('times');
    expectTypeOf<MndwHeatStripProps>().not.toHaveProperty('values');
    expectTypeOf<MndwHeatStripProps>().not.toHaveProperty('times');
  });

  it('exports the focus-trap utilities', () => {
    expect(typeof createFocusTrap).toBe('function');
    expect(typeof tabbableElements).toBe('function');
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

describe('chart tooltip formatter exports', () => {
  it('exports the chart tooltip formatter contract as a property-only option', () => {
    expect(MndwLineChart.properties.tooltipFormatter).toEqual({attribute: false});
    expect(MndwBarChart.properties.tooltipFormatter).toEqual({attribute: false});
    expectTypeOf<MndwChartTooltipSample>().toEqualTypeOf<{
      readonly seriesId: string;
      readonly label: string;
      readonly value: number;
      readonly time: number;
    }>();
    expectTypeOf<MndwChartTooltipContext>().toEqualTypeOf<{
      readonly time: number;
      readonly samples: readonly MndwChartTooltipSample[];
    }>();
    expectTypeOf<MndwChartTooltipContent>().toEqualTypeOf<{
      readonly title?: string;
      readonly rows: readonly {readonly label: string; readonly value: string}[];
    }>();
    expectTypeOf<MndwChartTooltipFormatter>().toEqualTypeOf<
      (context: MndwChartTooltipContext) => MndwChartTooltipContent | null
    >();
    expectTypeOf<MndwLineChartProps['tooltipFormatter']>().toEqualTypeOf<MndwChartTooltipFormatter | undefined>();
    expectTypeOf<MndwBarChartProps['tooltipFormatter']>().toEqualTypeOf<MndwChartTooltipFormatter | undefined>();
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

describe('icon sprite exports', () => {
  it('publishes typed href and sprite change helpers', () => {
    expect(mndwIconHref('activity')).toBe('');
    expect(typeof subscribeMndwIconSprite).toBe('function');
    expectTypeOf(mndwIconHref).toEqualTypeOf<(name: MndwIconName) => string>();
    expectTypeOf(subscribeMndwIconSprite).toEqualTypeOf<(callback: () => void) => () => void>();
  });
});
