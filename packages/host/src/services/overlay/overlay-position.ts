import type {OverlayAnchor, OverlayKind, OverlayLayerOptions, OverlayPlacement} from '@mndw/sdk';

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

/** Default flip search order for anchored popovers (spec suggestion). */
export const POPOVER_FLIP_ORDER: OverlayPlacement[] = [
  'bottom-start',
  'top-start',
  'bottom-end',
  'top-end',
];

const POPOVER_OFFSET_PX = 8;

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

export interface PopoverCoords {
  top: number;
  left: number;
  placement: OverlayPlacement;
}

interface Size {
  width: number;
  height: number;
}

function placementCoords(
  anchorRect: DOMRect,
  content: Size,
  placement: OverlayPlacement,
): {top: number; left: number} {
  switch (placement) {
    case 'top-start':
      return {top: anchorRect.top - content.height - POPOVER_OFFSET_PX, left: anchorRect.left};
    case 'top-end':
      return {
        top: anchorRect.top - content.height - POPOVER_OFFSET_PX,
        left: anchorRect.right - content.width,
      };
    case 'bottom-end':
      return {top: anchorRect.bottom + POPOVER_OFFSET_PX, left: anchorRect.right - content.width};
    case 'bottom-start':
    default:
      return {top: anchorRect.bottom + POPOVER_OFFSET_PX, left: anchorRect.left};
  }
}

function fitsInViewport(
  top: number,
  left: number,
  content: Size,
  viewport: Size,
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
  content: Size,
  placement: OverlayPlacement,
  viewport: Size = {width: window.innerWidth, height: window.innerHeight},
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
export function resolveSizing(kind: OverlayKind, options: OverlayLayerOptions): ResolvedSizing {
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
