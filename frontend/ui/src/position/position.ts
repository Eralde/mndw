import type {OverlayAnchor, OverlayKind, OverlayLayerOptions, OverlayPlacement} from '@mndw/sdk';
import type {UiLayerPresentation} from '../overlay.js';

export const MOBILE_OVERLAY_MAX_WIDTH = 600;
export const POPOVER_ANCHOR_GAP = 8;
export const VIEWPORT_PADDING = 8;

// Select keeps these names as a source-compatible alias while consuming the shared implementation.
export const SELECT_MOBILE_MAX_WIDTH = MOBILE_OVERLAY_MAX_WIDTH;
export const SELECT_ANCHOR_GAP = POPOVER_ANCHOR_GAP;
export const SELECT_VIEWPORT_PADDING = VIEWPORT_PADDING;

/** Default flip search order for anchored popovers. */
export const POPOVER_FLIP_ORDER: OverlayPlacement[] = [
  'bottom-start',
  'top-start',
  'bottom-end',
  'top-end',
];

const DRAWER_PLACEMENTS: ReadonlySet<OverlayPlacement> = new Set([
  'right',
  'left',
  'top',
  'bottom',
]);

const POPOVER_PLACEMENTS: ReadonlySet<OverlayPlacement> = new Set([
  'top-start',
  'top-end',
  'bottom-start',
  'bottom-end',
  'left-start',
  'left-end',
  'right-start',
  'right-end',
]);

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PositionSize {
  width: number;
  height: number;
}

export interface PopoverCoords {
  top: number;
  left: number;
  placement: OverlayPlacement;
}

export function isMobileSheet(kind: OverlayKind, viewportWidth = window.innerWidth): boolean {
  return viewportWidth <= MOBILE_OVERLAY_MAX_WIDTH && (kind === 'modal' || kind === 'drawer');
}

/** Coerces a requested placement into one valid for the given kind. */
export function coercePlacement(kind: OverlayKind, placement?: OverlayPlacement): OverlayPlacement {
  switch (kind) {
    case 'modal':
      return 'center';
    case 'drawer':
      return placement && DRAWER_PLACEMENTS.has(placement) ? placement : 'right';
    case 'popover':
      return placement && POPOVER_PLACEMENTS.has(placement) ? placement : 'bottom-start';
    case 'custom':
      return placement ?? 'center';
  }
}

function placementCoords(
  anchorRect: DOMRect,
  content: PositionSize,
  placement: OverlayPlacement,
): {top: number; left: number} {
  switch (placement) {
    case 'top-start':
      return {top: anchorRect.top - content.height - POPOVER_ANCHOR_GAP, left: anchorRect.left};
    case 'top-end':
      return {
        top: anchorRect.top - content.height - POPOVER_ANCHOR_GAP,
        left: anchorRect.right - content.width,
      };
    case 'bottom-end':
      return {top: anchorRect.bottom + POPOVER_ANCHOR_GAP, left: anchorRect.right - content.width};
    case 'bottom-start':
    default:
      return {top: anchorRect.bottom + POPOVER_ANCHOR_GAP, left: anchorRect.left};
  }
}

function fitsInViewport(
  top: number,
  left: number,
  content: PositionSize,
  viewport: ViewportSize,
): boolean {
  return top >= 0 && left >= 0 && top + content.height <= viewport.height
    && left + content.width <= viewport.width;
}

/**
 * Computes anchored popover coordinates for `placement`, flipping through
 * {@link POPOVER_FLIP_ORDER} when the preferred placement is clipped. Falls back
 * to the preferred placement if no candidate fits.
 */
export function computePopoverCoords(
  anchor: OverlayAnchor,
  content: PositionSize,
  placement: OverlayPlacement,
  viewport: ViewportSize = {width: window.innerWidth, height: window.innerHeight},
): PopoverCoords {
  const anchorRect = anchor.element.getBoundingClientRect();
  const preferred = placementCoords(anchorRect, content, placement);

  if (fitsInViewport(preferred.top, preferred.left, content, viewport)) {
    return {...preferred, placement};
  }

  const order = placement === POPOVER_FLIP_ORDER[0]
    ? POPOVER_FLIP_ORDER
    : [placement, ...POPOVER_FLIP_ORDER];

  for (const candidate of order) {
    const coords = placementCoords(anchorRect, content, candidate);

    if (fitsInViewport(coords.top, coords.left, content, viewport)) {
      return {...coords, placement: candidate};
    }
  }

  return {...preferred, placement};
}

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipCoords {
  top: number;
  left: number;
  placement: TooltipPlacement;
}

export type AnchorRect = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height'>;

/** Opposite first, then the perpendicular pair — a corner may need to leave the requested axis. */
const TOOLTIP_FLIP_ORDER: Record<TooltipPlacement, TooltipPlacement[]> = {
  top: ['top', 'bottom', 'right', 'left'],
  bottom: ['bottom', 'top', 'right', 'left'],
  left: ['left', 'right', 'bottom', 'top'],
  right: ['right', 'left', 'bottom', 'top'],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function tooltipCandidate(
  anchor: AnchorRect,
  content: PositionSize,
  placement: TooltipPlacement,
  gap: number,
): {top: number; left: number} {
  const centreX = anchor.left + ((anchor.width - content.width) / 2);
  const centreY = anchor.top + ((anchor.height - content.height) / 2);

  switch (placement) {
    case 'bottom':
      return {top: anchor.bottom + gap, left: centreX};
    case 'left':
      return {top: centreY, left: anchor.left - content.width - gap};
    case 'right':
      return {top: centreY, left: anchor.right + gap};
    case 'top':
    default:
      return {top: anchor.top - content.height - gap, left: centreX};
  }
}

/** Only the placement axis decides whether a candidate fits; the cross axis is clamped instead. */
function tooltipFits(
  candidate: {top: number; left: number},
  content: PositionSize,
  placement: TooltipPlacement,
  viewport: ViewportSize,
  padding: number,
): boolean {
  switch (placement) {
    case 'bottom':
      return candidate.top + content.height <= viewport.height - padding;
    case 'left':
      return candidate.left >= padding;
    case 'right':
      return candidate.left + content.width <= viewport.width - padding;
    case 'top':
    default:
      return candidate.top >= padding;
  }
}

/**
 * Computes centred tooltip coordinates for `placement`, flipping when the preferred side is
 * clipped and clamping the cross axis into the viewport. Falls back to the preferred side when no
 * candidate fits, so a tooltip larger than its space still appears where the author asked.
 */
export function computeTooltipCoords(
  anchor: AnchorRect,
  content: PositionSize,
  placement: TooltipPlacement,
  viewport: ViewportSize = {width: window.innerWidth, height: window.innerHeight},
  gap = POPOVER_ANCHOR_GAP,
  padding = VIEWPORT_PADDING,
): TooltipCoords {
  const order = TOOLTIP_FLIP_ORDER[placement];
  const chosen =
    order.find((candidate) =>
      tooltipFits(tooltipCandidate(anchor, content, candidate, gap), content, candidate, viewport, padding)
    ) ?? placement;
  const coords = tooltipCandidate(anchor, content, chosen, gap);
  const horizontal = chosen === 'top' || chosen === 'bottom';

  return {
    top: horizontal
      ? coords.top
      : clamp(coords.top, padding, Math.max(viewport.height - padding - content.height, padding)),
    left: horizontal
      ? clamp(coords.left, padding, Math.max(viewport.width - padding - content.width, padding))
      : coords.left,
    placement: chosen,
  };
}

export function selectPresentation(
  viewportWidth: number,
  mobileMaxWidth = SELECT_MOBILE_MAX_WIDTH,
): UiLayerPresentation {
  return viewportWidth <= mobileMaxWidth ? 'sheet' : 'popover';
}

export function availablePopoverHeight(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewport: ViewportSize,
  anchorGap = SELECT_ANCHOR_GAP,
  viewportPadding = SELECT_VIEWPORT_PADDING,
): number {
  const inset = anchorGap + viewportPadding;
  const below = Math.max(viewport.height - trigger.bottom - inset, 0);
  const above = Math.max(trigger.top - inset, 0);

  return Math.max(Math.max(below, above), 1);
}

function toCssSize(value: number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === 'number' ? `${value}px` : value;
}

export interface ResolvedSizing {
  width?: string;
  height?: string;
  maxWidth?: string;
  maxHeight?: string;
}

/** Resolves explicit sizing options, applying per-kind defaults for modal/drawer. */
export function resolveSizing(
  kind: OverlayKind,
  options: OverlayLayerOptions,
  mobileSheet = false,
): ResolvedSizing {
  if (mobileSheet && (kind === 'modal' || kind === 'drawer')) {
    return {
      width: '100%',
      height: 'auto',
      maxHeight: '100dvh',
    };
  }

  const width = toCssSize(options.width);
  const height = toCssSize(options.height);
  const maxWidth = toCssSize(options.maxWidth);
  const maxHeight = toCssSize(options.maxHeight);

  if (kind === 'modal') {
    return {
      width: width ?? 'min(560px, calc(100vw - 32px))',
      height,
      maxWidth,
      maxHeight: maxHeight ?? 'calc(100vh - 32px)',
    };
  }

  if (kind === 'drawer') {
    return {
      width: width ?? 'min(420px, 100vw)',
      height: height ?? '100%',
      maxWidth,
      maxHeight,
    };
  }

  return {width, height, maxWidth, maxHeight};
}
