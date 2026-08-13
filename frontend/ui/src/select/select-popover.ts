import {SELECT_VIEWPORT_PADDING, availablePopoverHeight, type ViewportSize} from '../position/position.js';

const PANEL_MIN_WIDTH = 180;

export interface PopoverGeometry {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export function readPopoverGeometry(rect: DOMRect): PopoverGeometry {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

export function samePopoverGeometry(left: PopoverGeometry | null, right: PopoverGeometry): boolean {
  return left?.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom
    && left.left === right.left
    && left.width === right.width
    && left.height === right.height;
}

export function applySelectPopoverSizing(
  contentElement: HTMLElement,
  rect: Pick<DOMRect, 'width' | 'top' | 'bottom'>,
  viewport: ViewportSize,
): void {
  contentElement.style.minWidth = `${Math.max(rect.width, PANEL_MIN_WIDTH)}px`;
  contentElement.style.maxWidth = `calc(100vw - ${SELECT_VIEWPORT_PADDING * 2}px)`;
  contentElement.style.maxHeight = `${availablePopoverHeight(rect, viewport)}px`;
  contentElement.style.overflow = 'hidden';
  contentElement.style.display = 'flex';
  contentElement.style.flexDirection = 'column';
}

export interface SelectPopoverTrackerOptions {
  isActive: () => boolean;
  isConnected: () => boolean;
  readAnchorRect: () => DOMRect;
  onGeometryChange: (rect: DOMRect) => void;
  onReposition: () => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (frame: number) => void;
}

export class SelectPopoverTracker {
  private readonly options:
    & Required<Pick<SelectPopoverTrackerOptions, 'requestFrame' | 'cancelFrame'>>
    & Omit<SelectPopoverTrackerOptions, 'requestFrame' | 'cancelFrame'>;
  private geometry: PopoverGeometry | null = null;
  private needsReposition = false;
  private frame: number | null = null;

  constructor(options: SelectPopoverTrackerOptions) {
    this.options = {
      ...options,
      requestFrame: options.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
      cancelFrame: options.cancelFrame ?? ((frame) => cancelAnimationFrame(frame)),
    };
  }

  public start(): void {
    this.cancel();
    this.needsReposition = true;
    this.frame = this.options.requestFrame(this.tick);
  }

  public cancel(): void {
    if (this.frame !== null) {
      this.options.cancelFrame(this.frame);
      this.frame = null;
    }

    this.geometry = null;
    this.needsReposition = false;
  }

  private readonly tick = (): void => {
    this.frame = null;

    if (!this.options.isActive()) {
      return;
    }

    const rect = this.options.readAnchorRect();
    const geometry = readPopoverGeometry(rect);
    const geometryChanged = !samePopoverGeometry(this.geometry, geometry);

    if (geometryChanged) {
      this.options.onGeometryChange(rect);
      this.geometry = geometry;
    }

    if ((this.needsReposition || geometryChanged) && this.options.isConnected()) {
      this.options.onReposition();
      this.needsReposition = false;
    }

    this.frame = this.options.requestFrame(this.tick);
  };
}
