import type {OverlayCloseEvent, OverlayLayer, OverlayService} from '@mndw/sdk';
import {describe, expect, it, vi} from 'vitest';
import type {ExtraFeaturesAvailability, ExtraFeaturesSetupReason} from '../services/mws-data.service';
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
  'limited',
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

  it('renders an opaque token-backed surface', () => {
    const {overlay, layer, anchor} = createOverlay();

    openExtraFeaturesPopover(overlay, anchor, 'active', (key) => key);

    const group = layer.contentElement.querySelector<HTMLElement>('[role="group"]');

    expect(group?.style.background).toBe('var(--mndw-surface-raised)');
    expect(group?.style.color).toBe('var(--mndw-text)');
    expect(group?.style.borderWidth).toBe('1px');
    expect(group?.style.borderStyle).toBe('solid');
    expect(group?.style.borderColor).toBe('var(--mndw-border)');
  });

  it.each(states)('links %s popover content to Settings', (state) => {
    const popover = createOverlay();

    openExtraFeaturesPopover(popover.overlay, popover.anchor, state, (key) => key);

    expect(popover.layer.contentElement.querySelector('a[href="/settings/general"]')).not.toBeNull();
  });

  it('updates current content, delegates close, and cleans mounted DOM', () => {
    const {overlay, layer, anchor, close} = createOverlay();
    const controller = openExtraFeaturesPopover(overlay, anchor, 'active', (key) => key);

    controller.update('limited');
    expect(layer.contentElement.textContent).toContain('extra-features.popover.limited.body');
    expect(layer.contentElement.textContent).not.toContain('extra-features.popover.active.body');

    controller.close();
    expect(close).toHaveBeenCalledOnce();
    expect(layer.contentElement.childElementCount).toBe(1);

    layer.runCleanup();
    expect(layer.contentElement.childElementCount).toBe(0);
  });

  it('renders combined blocker setup copy from machine-readable reasons', () => {
    const {overlay, layer, anchor} = createOverlay();
    const reasons: ExtraFeaturesSetupReason[] = ['permission', 'controller-token'];

    openExtraFeaturesPopover(overlay, anchor, 'blocked', (key) => key, reasons);

    expect(layer.contentElement.textContent).toContain('extra-features.popover.blocked.combined.body');
  });

  it('renders extender-session setup copy for unavailable availability', () => {
    const {overlay, layer, anchor} = createOverlay();

    openExtraFeaturesPopover(overlay, anchor, 'unavailable', (key) => key, ['extender-session']);

    expect(layer.contentElement.textContent).toContain('extra-features.popover.unavailable.extender-session.body');
  });
});
