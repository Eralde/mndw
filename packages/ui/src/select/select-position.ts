import type {UiLayerPresentation} from '../overlay.js';

export const SELECT_MOBILE_MAX_WIDTH = 600;
export const SELECT_ANCHOR_GAP = 4;
export const SELECT_VIEWPORT_PADDING = 8;

export interface SelectViewport {
  width: number;
  height: number;
}

export function selectPresentation(viewportWidth: number): UiLayerPresentation {
  return viewportWidth <= SELECT_MOBILE_MAX_WIDTH ? 'sheet' : 'popover';
}

export function availablePopoverHeight(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewport: SelectViewport,
): number {
  const inset = SELECT_ANCHOR_GAP + SELECT_VIEWPORT_PADDING;
  const below = Math.max(viewport.height - trigger.bottom - inset, 0);
  const above = Math.max(trigger.top - inset, 0);

  return Math.max(Math.max(below, above), 1);
}
