import type {OverlayCloseEvent, OverlayLayer, OverlayService} from '@mndw/sdk';
import {describe, expect, it, vi} from 'vitest';
import type {ExtraFeaturesAvailability} from '../services/mws-data.service';
import {openExtraFeaturesPopover} from './extra-features-popover';

interface FakeLayer extends OverlayLayer {
  runCleanup: () => void;
}

function createOverlay(): {
  overlay: OverlayService;
  layer: FakeLayer;
  anchor: HTMLElement;
  createLayer: ReturnType<typeof vi.fn>;
  markReady: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const anchor = document.createElement('button');
  const contentElement = document.createElement('div');
  const hostElement = document.createElement('div');
  const abortController = new AbortController();
  let cleanup: (() => void) | undefined;
  const close = vi.fn();
  const markReady = vi.fn();
  const layer: FakeLayer = {
    anchor: undefined,
    hostElement,
    contentElement,
    isOpen: true,
    state: 'open',
    signal: abortController.signal,
    closed: Promise.resolve<OverlayCloseEvent>({reason: 'api'}),
    close,
    setCleanup: vi.fn((value) => {
      cleanup = typeof value === 'function' ? value : undefined;
    }),
    markReady,
    update: vi.fn(),
    onClose: vi.fn(() => () => undefined),
    runCleanup: () => cleanup?.(),
  };
  const createLayer = vi.fn(() => layer);
  const overlay = {
    createLayer,
    open: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as OverlayService;

  return {overlay, layer, anchor, createLayer, markReady, close};
}

const states: ExtraFeaturesAvailability[] = [
  'checking',
  'active',
  'starting',
  'unavailable',
  'degraded',
  'blocked',
  'incompatible',
];

describe('openExtraFeaturesPopover', () => {
  it('creates a non-modal anchored popover with host dismissal behavior', () => {
    const {overlay, anchor, createLayer, markReady} = createOverlay();

    openExtraFeaturesPopover(overlay, anchor, 'checking', (key) => key);

    expect(createLayer).toHaveBeenCalledWith({
      kind: 'popover',
      anchor: {element: anchor},
      placement: 'bottom-end',
      closeOnEscape: true,
      closeOnOutsideClick: true,
      trapFocus: false,
      restoreFocus: true,
      lockScroll: false,
    });
    expect(markReady).toHaveBeenCalledOnce();
  });

  it.each(states)('renders distinct labelled content for %s', (state) => {
    const {overlay, layer, anchor} = createOverlay();

    openExtraFeaturesPopover(overlay, anchor, state, (key) => key);

    const group = layer.contentElement.querySelector('[role="group"]');
    const title = group?.querySelector('h3');
    const body = group?.querySelector('p');

    expect(group?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(title?.textContent).toContain(`extra-features.popover.${state}.title`);
    expect(body?.textContent).toContain(`extra-features.popover.${state}.body`);
  });

  it('shows settings action only for unavailable state', () => {
    const unavailable = createOverlay();

    openExtraFeaturesPopover(unavailable.overlay, unavailable.anchor, 'unavailable', (key) => key);
    expect(unavailable.layer.contentElement.querySelector('a[href="/settings/general"]')).not.toBeNull();

    const blocked = createOverlay();

    openExtraFeaturesPopover(blocked.overlay, blocked.anchor, 'blocked', (key) => key);
    expect(blocked.layer.contentElement.querySelector('a')).toBeNull();
  });

  it('updates current content, delegates close, and cleans mounted DOM', () => {
    const {overlay, layer, anchor, close} = createOverlay();
    const controller = openExtraFeaturesPopover(overlay, anchor, 'active', (key) => key);

    controller.update('degraded');
    expect(layer.contentElement.textContent).toContain('extra-features.popover.degraded.body');
    expect(layer.contentElement.textContent).not.toContain('extra-features.popover.active.body');

    controller.close();
    expect(close).toHaveBeenCalledOnce();
    expect(layer.contentElement.childElementCount).toBe(1);

    layer.runCleanup();
    expect(layer.contentElement.childElementCount).toBe(0);
  });
});
