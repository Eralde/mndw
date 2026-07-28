import type {
  OverlayCloseEvent,
  OverlayCloseReason,
  OverlayKind,
  OverlayLayer,
  OverlayLayerOptions,
  OverlayOpenOptions,
  OverlayPlacement,
  OverlayService,
  OverlaySession,
} from '@mndw/sdk';
import {
  type ResolvedSizing,
  coercePlacement,
  computePopoverCoords,
  isMobileSheet,
  resolveSizing,
} from './overlay-position.js';

/** Reasons the host applies internally; never assignable through public `close()`. */
type HostCloseReason = OverlayCloseReason;

/** Recommended guard against a plugin that never marks a `createLayer()` ready. */
const OPEN_TIMEOUT_MS = 10000;

type CleanupInput = (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

interface BehaviorDefaults {
  placement: OverlayPlacement;
  closeOnEscape: boolean;
  closeOnOutsideClick: boolean;
  trapFocus: boolean;
  restoreFocus: boolean;
  lockScroll: boolean;
  backdrop: boolean;
}

function behaviorDefaults(kind: OverlayKind): BehaviorDefaults {
  switch (kind) {
    case 'modal':
      return {
        placement: 'center',
        closeOnEscape: true,
        closeOnOutsideClick: false,
        trapFocus: true,
        restoreFocus: true,
        lockScroll: true,
        backdrop: true,
      };
    case 'drawer':
      return {
        placement: 'right',
        closeOnEscape: true,
        closeOnOutsideClick: true,
        trapFocus: true,
        restoreFocus: true,
        lockScroll: true,
        backdrop: true,
      };
    case 'popover':
      return {
        placement: 'bottom-start',
        closeOnEscape: true,
        closeOnOutsideClick: true,
        trapFocus: false,
        restoreFocus: false,
        lockScroll: false,
        backdrop: false,
      };
    case 'custom':
      return {
        placement: 'center',
        closeOnEscape: false,
        closeOnOutsideClick: false,
        trapFocus: false,
        restoreFocus: false,
        lockScroll: false,
        backdrop: false,
      };
  }
}

export interface ShellConfig {
  title?: string;
  description?: string;
  showCloseButton: boolean;
}

/**
 * Non-generic projection of a layer used by the reactive store and renderer.
 * Keeps the store free of the `Result` type parameter (which is invariant on
 * {@link LayerController}) so layers from different plugins share one array.
 */
export interface OverlayLayerView {
  readonly id: number;
  readonly kind: OverlayKind;
  readonly instanceId: string;
  readonly hostElement: HTMLElement;
  readonly contentElement: HTMLElement;
  readonly anchorElement: HTMLElement | null;
  state: 'opening' | 'open' | 'closing' | 'closed';
  shell: ShellConfig | null;
  placement: OverlayPlacement;
  readonly mobileSheet: boolean;
  className: string | undefined;
  sizing: ResolvedSizing;
  position: {top: number; left: number} | null;
  readonly closeOnEscape: boolean;
  readonly closeOnOutsideClick: boolean;
  readonly trapFocus: boolean;
  readonly lockScroll: boolean;
  readonly backdrop: boolean;
  close(result?: unknown, reason?: 'api' | 'action'): void;
  closeWithReason(reason: OverlayCloseReason): void;
  reposition(): void;
}

let nextLayerId = 1;

class LayerController<Result = unknown> implements OverlaySession<Result> {
  public readonly id: number;
  public readonly pluginName: string;
  public readonly instanceId: string;
  public readonly kind: OverlayKind;
  public readonly hostElement: HTMLElement;
  public readonly contentElement: HTMLElement;

  public state = $state<'opening' | 'open' | 'closing' | 'closed'>('opening');
  public shell = $state<ShellConfig | null>(null);
  public placement = $state<OverlayPlacement>('center');
  public readonly mobileSheet: boolean;
  public className = $state<string | undefined>(undefined);
  public sizing = $state<ResolvedSizing>({});
  public position = $state<{top: number; left: number} | null>(null);

  public readonly behavior: BehaviorDefaults;
  public readonly closeOnEscape: boolean;
  public readonly closeOnOutsideClick: boolean;
  public readonly trapFocus: boolean;
  public readonly restoreFocus: boolean;
  public readonly lockScroll: boolean;
  public readonly backdrop: boolean;

  public readonly closed: Promise<OverlayCloseEvent<Result>>;

  private readonly abortController = new AbortController();
  public anchorElement: HTMLElement | null;
  private cleanup: CleanupInput | null = null;
  private readonly onCloseListeners = new Set<(event: OverlayCloseEvent<Result>) => void>();
  private readonly previousFocus: HTMLElement | null;
  private closedResolve!: (event: OverlayCloseEvent<Result>) => void;
  private openTimeout: ReturnType<typeof setTimeout> | undefined;
  private repositionHandler: (() => void) | null = null;
  private anchorObserver: MutationObserver | null = null;

  constructor(
    pluginName: string,
    instanceId: string,
    options: OverlayLayerOptions,
    shell: ShellConfig | null,
  ) {
    this.id = nextLayerId++;
    this.pluginName = pluginName;
    this.instanceId = instanceId;
    this.kind = options.kind;

    const defaults = behaviorDefaults(options.kind);

    this.behavior = defaults;
    this.closeOnEscape = options.closeOnEscape ?? defaults.closeOnEscape;
    this.closeOnOutsideClick = options.closeOnOutsideClick ?? defaults.closeOnOutsideClick;
    this.trapFocus = options.trapFocus ?? defaults.trapFocus;
    this.restoreFocus = options.restoreFocus ?? defaults.restoreFocus;
    this.lockScroll = options.lockScroll ?? defaults.lockScroll;
    this.backdrop = defaults.backdrop;

    this.shell = shell;
    this.placement = coercePlacement(options.kind, options.placement);
    this.mobileSheet = isMobileSheet(options.kind);
    this.className = options.className;
    this.sizing = resolveSizing(options.kind, options, this.mobileSheet);
    this.anchorElement = options.anchor?.element ?? null;

    this.hostElement = document.createElement('div');
    this.hostElement.className = 'mndw-overlay-layer';
    this.contentElement = document.createElement('div');
    this.contentElement.className = 'mndw-overlay-content';

    // For shellless layers, plugin content mounts straight into the layer root.
    // For shell-backed layers, OverlayShell inserts contentElement into its body.
    if (!shell) {
      this.hostElement.appendChild(this.contentElement);
    }

    this.previousFocus = this.restoreFocus && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });

    this.openTimeout = setTimeout(() => {
      if (this.state === 'opening') {
        void this.closeInternal('mount-failed');
      }
    }, OPEN_TIMEOUT_MS);

    this.attachAnchorObservers();
  }

  public get isOpen(): boolean {
    return this.state === 'opening' || this.state === 'open';
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public close(result?: Result, reason: 'api' | 'action' = 'api'): void {
    void this.closeInternal(reason, result);
  }

  /** Host-internal close with any reason (unmount, navigation, replaced, etc.). */
  public closeWithReason(reason: HostCloseReason, result?: Result): void {
    void this.closeInternal(reason, result);
  }

  public setCleanup(cleanup: CleanupInput): void {
    if (this.state === 'closed') {
      return;
    }

    this.cleanup = cleanup;
  }

  public markReady(): void {
    if (this.state !== 'opening') {
      return;
    }

    this.clearOpenTimeout();
    this.state = 'open';
  }

  public update(
    options: Partial<{
      title: string;
      description: string;
      showCloseButton: boolean;
      placement: OverlayPlacement;
      anchor: {element: HTMLElement};
      className: string;
      width: number | string;
      height: number | string;
      maxWidth: number | string;
      maxHeight: number | string;
    }>,
  ): void {
    if (!this.isOpen) {
      return;
    }

    if (options.className !== undefined) {
      this.className = options.className;
    }

    if (options.placement !== undefined) {
      this.placement = coercePlacement(this.kind, options.placement);
    }

    // Shell-backed layers are never anchored; ignore anchor updates for them.
    if (options.anchor !== undefined && !this.shell) {
      this.anchorElement = options.anchor.element;
      this.attachAnchorObservers();
    }

    if (this.shell) {
      const next: ShellConfig = {...(this.shell ?? {showCloseButton: true})};

      if (options.title !== undefined) {
        next.title = options.title;
      }

      if (options.description !== undefined) {
        next.description = options.description;
      }

      if (options.showCloseButton !== undefined) {
        next.showCloseButton = options.showCloseButton;
      }

      this.shell = next;
    }

    if (
      options.width !== undefined || options.height !== undefined
      || options.maxWidth !== undefined || options.maxHeight !== undefined
    ) {
      this.sizing = resolveSizing(
        this.kind,
        {
          kind: this.kind,
          width: options.width,
          height: options.height,
          maxWidth: options.maxWidth,
          maxHeight: options.maxHeight,
        },
        this.mobileSheet,
      );
    }

    this.reposition();
  }

  public onClose(listener: (event: OverlayCloseEvent<Result>) => void): () => void {
    this.onCloseListeners.add(listener);

    return () => {
      this.onCloseListeners.delete(listener);
    };
  }

  public reposition(): void {
    if (this.kind !== 'popover' || !this.anchorElement) {
      return;
    }

    const rect = this.contentElement.getBoundingClientRect();

    // The host can render the positioner before plugin content has laid out.
    // Keep it hidden until a real size exists so an anchored popover cannot flash
    // at its preferred side before its final placement is known.
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const coords = computePopoverCoords(
      {element: this.anchorElement},
      {width: rect.width, height: rect.height},
      this.placement,
    );

    this.placement = coords.placement;
    this.position = {top: coords.top, left: coords.left};
  }

  private attachAnchorObservers(): void {
    this.detachAnchorObservers();

    if (this.kind !== 'popover' || !this.anchorElement) {
      return;
    }

    const anchor = this.anchorElement;

    this.repositionHandler = () => {
      requestAnimationFrame(() => this.reposition());
    };

    window.addEventListener('scroll', this.repositionHandler, true);
    window.addEventListener('resize', this.repositionHandler);

    // Close the popover if its anchor leaves the document.
    this.anchorObserver = new MutationObserver(() => {
      if (!anchor.isConnected) {
        void this.closeInternal('anchor-lost');
      }
    });
    this.anchorObserver.observe(document.body, {childList: true, subtree: true});
  }

  private detachAnchorObservers(): void {
    if (this.repositionHandler) {
      window.removeEventListener('scroll', this.repositionHandler, true);
      window.removeEventListener('resize', this.repositionHandler);
      this.repositionHandler = null;
    }

    this.anchorObserver?.disconnect();
    this.anchorObserver = null;
  }

  private clearOpenTimeout(): void {
    if (this.openTimeout !== undefined) {
      clearTimeout(this.openTimeout);
      this.openTimeout = undefined;
    }
  }

  private async closeInternal(reason: HostCloseReason, result?: Result): Promise<void> {
    if (this.state === 'closing' || this.state === 'closed') {
      return;
    }

    this.state = 'closing';
    this.clearOpenTimeout();
    this.abortController.abort();
    this.detachAnchorObservers();

    const cleanup = this.cleanup;

    if (cleanup) {
      try {
        const fn = cleanup instanceof Promise ? await cleanup : cleanup;

        await fn();
      } catch (err) {
        // Cleanup failure never rewrites the close reason.
        console.error(`[mndw] Overlay cleanup for "${this.pluginName}" failed:`, err);
      }
    }

    this.restoreFocusOnClose();
    removeLayer(this);
    this.state = 'closed';

    const event: OverlayCloseEvent<Result> = {reason, result};

    this.closedResolve(event);

    for (const listener of this.onCloseListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[mndw] Overlay onClose listener for "${this.pluginName}" failed:`, err);
      }
    }
  }

  private restoreFocusOnClose(): void {
    const active = document.activeElement;

    if (this.kind === 'popover' && this.anchorElement?.isConnected) {
      const insidePopover = this.contentElement.contains(active);
      const focusLost = !active || active === document.body;

      if (insidePopover || focusLost) {
        this.anchorElement.focus();
      }

      return;
    }

    if (this.restoreFocus && this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
  }
}

class OverlayStore {
  public layers = $state<OverlayLayerView[]>([]);
}

export const overlayStore = new OverlayStore();

function removeLayer(layer: OverlayLayerView): void {
  const index = overlayStore.layers.indexOf(layer);

  if (index !== -1) {
    overlayStore.layers.splice(index, 1);
  }
}

function addLayer(layer: OverlayLayerView): void {
  // Opening a modal supersedes earlier same-plugin popovers (reason 'replaced').
  if (layer.kind === 'modal') {
    for (const existing of [...overlayStore.layers]) {
      if (existing.instanceId === layer.instanceId && existing.kind === 'popover') {
        existing.closeWithReason('replaced');
      }
    }
  }

  overlayStore.layers.push(layer);
}

export interface PluginOverlayBundle {
  service: OverlayService;
  /** Host-internal teardown; closes this instance's overlays with the given reason. */
  dispose: (reason?: 'plugin-unmount' | 'host-navigation') => void;
}

/**
 * Creates the per-plugin-instance overlay service plus a host-internal `dispose`
 * hook. Plugins receive only `service`; the host runtime holds `dispose` and runs
 * it on unmount/navigation so those reasons never flow through plugin-facing APIs.
 */
export function createPluginOverlayService(
  pluginName: string,
  instanceId: string,
): PluginOverlayBundle {
  let disposed = false;

  function assertLive(): void {
    if (disposed) {
      throw new Error(
        `[mndw] Overlay service for "${pluginName}" (${instanceId}) is disposed; `
          + 'the plugin instance was unmounted.',
      );
    }
  }

  function instanceLayers(): OverlayLayerView[] {
    return overlayStore.layers.filter((layer) => layer.instanceId === instanceId);
  }

  const service: OverlayService = {
    createLayer<Result = unknown>(options: OverlayLayerOptions): OverlayLayer<Result> {
      assertLive();

      const layer = new LayerController<Result>(pluginName, instanceId, options, null);

      addLayer(layer);

      return layer;
    },
    open<Result = unknown>(options: OverlayOpenOptions<Result>): OverlaySession<Result> {
      assertLive();

      const {title, description, showCloseButton, mount, kind, ...rest} = options;
      const layer = new LayerController<Result>(
        pluginName,
        instanceId,
        {kind, ...rest},
        {title, description, showCloseButton: showCloseButton ?? true},
      );

      addLayer(layer);

      try {
        const result = mount(layer.contentElement, layer, layer.signal);

        if (result instanceof Promise) {
          result.then(() => layer.markReady()).catch((err: unknown) => {
            console.error(`[mndw] Overlay mount for "${pluginName}" failed:`, err);
            layer.closeWithReason('mount-failed');
          });
        } else {
          layer.markReady();
        }
      } catch (err) {
        console.error(`[mndw] Overlay mount for "${pluginName}" failed:`, err);
        layer.closeWithReason('mount-failed');
      }

      return layer;
    },
    closeAll(): void {
      for (const layer of instanceLayers()) {
        layer.close(undefined, 'api');
      }
    },
  };

  function dispose(reason: 'plugin-unmount' | 'host-navigation' = 'plugin-unmount'): void {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const layer of instanceLayers()) {
      layer.closeWithReason(reason);
    }
  }

  return {service, dispose};
}

/** Test-only: clears all overlay state between cases. */
export function resetOverlayStateForTests(): void {
  overlayStore.layers.splice(0, overlayStore.layers.length);
  nextLayerId = 1;
}
