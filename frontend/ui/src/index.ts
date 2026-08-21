import type {OverlayService} from '@mndw/sdk';
import {MNDW_BAR_CHART_TAG, MndwBarChart} from './charts/bar-chart.js';
import {MNDW_LINE_CHART_TAG, MndwLineChart} from './charts/line-chart.js';
import {MNDW_BUTTON_TAG, MndwButton} from './button/button.js';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from './checkbox/checkbox.js';
import {MNDW_FIELD_TAG, MndwField} from './field/field.js';
import {MNDW_INPUT_TAG, MndwInput} from './input/input.js';
import {adaptOverlayService} from './overlay-adapter.js';
import {setOverlayProvider} from './overlay.js';
import {MNDW_OPTION_TAG, MndwOption} from './select/option.js';
import {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select/select-panel.js';
import {MNDW_SELECT_TAG, MndwSelect} from './select/select.js';
import {MNDW_SCROLL_AREA_TAG, MndwScrollArea} from './scroll-area/scroll-area.js';
import {MNDW_SEGMENT_TAG, MndwSegment} from './segmented/segment.js';
import {MNDW_SEGMENTED_TAG, MndwSegmented} from './segmented/segmented.js';
import {MNDW_SLIDER_TAG, MndwSlider} from './slider/slider.js';
import {MNDW_SWITCH_TAG, MndwSwitch} from './switch/switch.js';
import {MNDW_TAB_PANEL_TAG, MndwTabPanel} from './tabs/tab-panel.js';
import {MNDW_TAB_TAG, MndwTab} from './tabs/tab.js';
import {MNDW_TABS_TAG, MndwTabs} from './tabs/tabs.js';
import {MNDW_TEXTAREA_TAG, MndwTextarea} from './textarea/textarea.js';
import {MNDW_TOOLTIP_TAG, MndwTooltip} from './tooltip/tooltip.js';
import {setMndwUiLocale} from './i18n.js';
import {MNDW_COLUMN_MENU_TAG, MndwColumnMenu} from './table/column-menu.js';
import {MNDW_TABLE_TAG, MndwTable} from './table/table.js';

export {MNDW_BUTTON_TAG, MndwButton} from './button/button.js';
export type {MndwButtonVariant} from './button/button.js';
export {MNDW_BAR_CHART_TAG, MndwBarChart} from './charts/bar-chart.js';
export {MNDW_LINE_CHART_TAG, MndwLineChart} from './charts/line-chart.js';
export type {MndwChartColor, MndwChartDomain, MndwChartPoint, MndwChartSeries} from './charts/chart-types.js';
export {formatSpeed} from './charts/chart-utils.js';
export {MNDW_CHECKBOX_TAG, MndwCheckbox} from './checkbox/checkbox.js';
export type {MndwCheckboxChangeDetail} from './checkbox/checkbox.js';
export {MNDW_FIELD_TAG, MNDW_LABEL_CHANGE_EVENT, MndwField} from './field/field.js';
export type {MndwLabelSource} from './field/field.js';
export {MNDW_INPUT_TAG, MNDW_INPUT_TYPES, MndwInput} from './input/input.js';
export type {MndwInputChangeDetail, MndwInputType} from './input/input.js';
export {MNDW_OPTION_TAG, MndwOption} from './select/option.js';
export {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select/select-panel.js';
export {MNDW_SELECT_TAG, MndwSelect} from './select/select.js';
export type {MndwSelectChangeDetail} from './select/select.js';
export {MNDW_OPTION_CHANGE_EVENT} from './select/option.js';
export {MNDW_SCROLL_AREA_TAG, MndwScrollArea} from './scroll-area/scroll-area.js';
export {MNDW_SEGMENT_CHANGE_EVENT, MNDW_SEGMENT_TAG, MndwSegment} from './segmented/segment.js';
export {MNDW_SEGMENTED_TAG, MndwSegmented} from './segmented/segmented.js';
export type {MndwSegmentedChangeDetail} from './segmented/segmented.js';
export {MNDW_SLIDER_TAG, MndwSlider} from './slider/slider.js';
export type {MndwSliderChangeDetail, MndwSliderInputDetail} from './slider/slider.js';
export {MNDW_SWITCH_TAG, MndwSwitch} from './switch/switch.js';
export type {MndwSwitchChangeDetail} from './switch/switch.js';
export {MNDW_TAB_PANEL_TAG, MndwTabPanel} from './tabs/tab-panel.js';
export {MNDW_TAB_TAG, MndwTab} from './tabs/tab.js';
export {MNDW_TABS_TAG, MndwTabs} from './tabs/tabs.js';
export type {MndwTabsChangeDetail} from './tabs/tabs.js';
export {MNDW_TEXTAREA_TAG, MndwTextarea} from './textarea/textarea.js';
export type {MndwTextareaChangeDetail} from './textarea/textarea.js';
export {MNDW_TOOLTIP_TAG, MndwTooltip} from './tooltip/tooltip.js';
export type {MndwTooltipPlacement} from './tooltip/tooltip.js';
export {MNDW_COLUMN_MENU_TAG, MndwColumnMenu} from './table/column-menu.js';
export {MNDW_TABLE_TAG, MndwTable} from './table/table.js';
export {getMndwUiLocale, getMndwUiText, setMndwUiLocale, subscribeMndwUiLocale} from './i18n.js';
export {column} from './table/table-builder.js';
export type {ColumnBuilder} from './table/table-builder.js';
export {
  DETAIL_COL_ID,
  MNDW_COLUMN_VISIBILITY_CHANGE_EVENT,
  MNDW_ERROR_EVENT,
  MNDW_ROW_EXPAND_EVENT,
  MNDW_ROW_REORDER_EVENT,
  MNDW_SELECTION_CHANGE_EVENT,
  MNDW_SORT_CHANGE_EVENT,
} from './table/table-types.js';
export type {
  BadgeTone,
  CellAlign,
  CellContext,
  CellKind,
  CellProps,
  CellRenderer,
  Column,
  ColumnDef,
  MndwColumnVisibilityChangeDetail,
  MndwErrorDetail,
  MndwRowExpandDetail,
  MndwRowReorderDetail,
  MndwSelectionChangeDetail,
  MndwSortChangeDetail,
  MndwTableLabels,
  MndwTableProps,
  RowKey,
  ScrollToRowOptions,
  SortState,
  StringKeyOf,
  Violation,
} from './table/table-types.js';
export {createGeneratedAttribute, createLocalizedProperty} from './localized-property.js';
export type {UiCloseReason, UiLayer, UiLayerOptions, UiLayerPresentation, UiOverlayProvider} from './overlay.js';
export {
  availablePopoverHeight,
  coercePlacement,
  computePopoverCoords,
  computeTooltipCoords,
  isMobileSheet,
  MOBILE_OVERLAY_MAX_WIDTH,
  POPOVER_ANCHOR_GAP,
  POPOVER_FLIP_ORDER,
  resolveSizing,
  SELECT_ANCHOR_GAP,
  SELECT_MOBILE_MAX_WIDTH,
  SELECT_VIEWPORT_PADDING,
  selectPresentation,
  VIEWPORT_PADDING,
} from './position/position.js';
export type {
  AnchorRect,
  PopoverCoords,
  PositionSize,
  ResolvedSizing,
  TooltipCoords,
  TooltipPlacement,
  ViewportSize,
} from './position/position.js';

export interface MndwUiDeps {
  overlay?: OverlayService;
  initialLocale?: string;
}

const REGISTRY: [string, CustomElementConstructor][] = [
  [MNDW_BAR_CHART_TAG, MndwBarChart],
  [MNDW_BUTTON_TAG, MndwButton],
  [MNDW_CHECKBOX_TAG, MndwCheckbox],
  [MNDW_FIELD_TAG, MndwField],
  [MNDW_INPUT_TAG, MndwInput],
  [MNDW_LINE_CHART_TAG, MndwLineChart],
  [MNDW_OPTION_TAG, MndwOption],
  [MNDW_SCROLL_AREA_TAG, MndwScrollArea],
  [MNDW_SELECT_PANEL_TAG, MndwSelectPanel],
  [MNDW_SELECT_TAG, MndwSelect],
  [MNDW_SEGMENT_TAG, MndwSegment],
  [MNDW_SEGMENTED_TAG, MndwSegmented],
  [MNDW_SLIDER_TAG, MndwSlider],
  [MNDW_SWITCH_TAG, MndwSwitch],
  [MNDW_TAB_PANEL_TAG, MndwTabPanel],
  [MNDW_TAB_TAG, MndwTab],
  [MNDW_TABS_TAG, MndwTabs],
  [MNDW_TEXTAREA_TAG, MndwTextarea],
  [MNDW_TOOLTIP_TAG, MndwTooltip],
  [MNDW_TABLE_TAG, MndwTable],
  [MNDW_COLUMN_MENU_TAG, MndwColumnMenu],
];

export function defineMndwUi(deps?: MndwUiDeps): void {
  if (deps?.initialLocale !== undefined) {
    setMndwUiLocale(deps.initialLocale);
  }

  if (deps?.overlay) {
    setOverlayProvider(adaptOverlayService(deps.overlay));
  }

  for (const [tag, constructor] of REGISTRY) {
    if (!customElements.get(tag)) {
      customElements.define(tag, constructor);
    }
  }
}
