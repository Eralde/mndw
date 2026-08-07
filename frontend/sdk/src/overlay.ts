/**
 * Framework-agnostic overlay SDK. Host owns stacking, focus, dismissal, backdrop,
 * scroll lock, and cleanup; plugins mount their own content into host-provided
 * targets and register teardown. Host never re-parents already-rendered plugin DOM.
 */

export type OverlayKind = 'modal' | 'drawer' | 'popover' | 'custom';

export type OverlayPlacement =
  | 'center'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'right-start'
  | 'right-end'
  | 'left-start'
  | 'left-end';

/**
 * Only `api` and `action` are plugin-assignable via `close()`. All other reasons
 * are host-assigned (navigation, unmount, replacement, anchor loss, mount failure).
 */
export type OverlayCloseReason =
  | 'api'
  | 'action'
  | 'escape'
  | 'outside-click'
  | 'host-navigation'
  | 'plugin-unmount'
  | 'replaced'
  | 'anchor-lost'
  | 'mount-failed';

export interface OverlayAnchor {
  element: HTMLElement;
}

export interface OverlayCloseEvent<Result = unknown> {
  reason: OverlayCloseReason;
  result?: Result;
}

export interface OverlayLayerOptions {
  kind: OverlayKind;
  anchor?: OverlayAnchor;
  placement?: OverlayPlacement;
  width?: number | string;
  height?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
  trapFocus?: boolean;
  restoreFocus?: boolean;
  lockScroll?: boolean;
  /** Applied to `hostElement` only. Host-owned shell internals stay host-controlled. */
  className?: string;
}

export interface OverlayLayer<Result = unknown> {
  readonly hostElement: HTMLElement;
  /** Plugin mount target. For `open()` this is the shell body slot. */
  readonly contentElement: HTMLElement;
  /** Convenience: true while `state` is 'opening' or 'open'. */
  readonly isOpen: boolean;
  readonly state: 'opening' | 'open' | 'closing' | 'closed';
  readonly closed: Promise<OverlayCloseEvent<Result>>;
  /** Aborts when `closing` starts. Same object is passed to the `open()` mount callback. */
  readonly signal: AbortSignal;

  /** Idempotent; valid in any state except `closed`. `reason` defaults to 'api'. */
  close(result?: Result, reason?: 'api' | 'action'): void;
  /** Register teardown as part of setup. Last call before `closing` wins. */
  setCleanup(cleanup: (() => void | Promise<void>) | Promise<() => void | Promise<void>>): void;
  /** Signal the layer is safe for interaction; moves state to `open`. */
  markReady(): void;
  update(
    options: Partial<
      Pick<
        OverlayLayerOptions,
        'placement' | 'anchor' | 'className' | 'width' | 'height' | 'maxWidth' | 'maxHeight'
      >
    >,
  ): void;
  onClose(listener: (event: OverlayCloseEvent<Result>) => void): () => void;
}

export type OverlayMount<Result = unknown> = (
  target: HTMLElement,
  layer: OverlayLayer<Result>,
  signal: AbortSignal,
) => void | Promise<void>;

export interface OverlayOpenOptions<Result = unknown> extends Omit<OverlayLayerOptions, 'kind' | 'anchor'> {
  kind: 'modal' | 'drawer';
  title?: string;
  description?: string;
  showCloseButton?: boolean;
  mount: OverlayMount<Result>;
}

export interface OverlaySession<Result = unknown> extends OverlayLayer<Result> {
  update(
    options: Partial<
      Pick<
        OverlayOpenOptions<Result>,
        | 'title'
        | 'description'
        | 'showCloseButton'
        | 'width'
        | 'height'
        | 'maxWidth'
        | 'maxHeight'
        | 'placement'
        | 'className'
      >
    >,
  ): void;
}

export interface OverlayService {
  createLayer<Result = unknown>(options: OverlayLayerOptions): OverlayLayer<Result>;
  open<Result = unknown>(options: OverlayOpenOptions<Result>): OverlaySession<Result>;
  /** Closes all overlays opened by this plugin instance with reason 'api'. */
  closeAll(): void;
}
