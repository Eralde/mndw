import {afterEach, describe, expect, it, vi} from 'vitest';
import {deepActiveElement} from './focus.js';
import {setMndwUiLocale} from './i18n.js';
import {
  type UiLayer,
  type UiOverlayProvider,
  createFallbackProvider,
  getOverlayProvider,
  setOverlayProvider,
} from './overlay.js';

const openLayers: UiLayer[] = [];

function track(layer: UiLayer): UiLayer {
  openLayers.push(layer);

  return layer;
}

afterEach(() => {
  setMndwUiLocale('en');

  for (const layer of openLayers.splice(0)) {
    layer.close();
  }

  setOverlayProvider(undefined);
  document.body.innerHTML = '';
});

function anchor(): HTMLElement {
  const element = document.createElement('button');

  document.body.appendChild(element);

  return element;
}

function openFallback(
  target: HTMLElement = anchor(),
  options: Pick<Parameters<UiOverlayProvider['open']>[0], 'presentation' | 'title' | 'className' | 'trapFocus'> = {},
): UiLayer {
  return track(createFallbackProvider().open({anchor: target, ...options}));
}

describe('overlay provider slot', () => {
  it('falls back when no provider is injected', () => {
    expect(getOverlayProvider()).toBeDefined();
  });

  it('returns the injected provider', () => {
    const provider: UiOverlayProvider = {open: vi.fn()} as unknown as UiOverlayProvider;

    setOverlayProvider(provider);

    expect(getOverlayProvider()).toBe(provider);
  });

  it('restores the fallback when the provider is cleared', () => {
    const provider: UiOverlayProvider = {open: vi.fn()} as unknown as UiOverlayProvider;

    setOverlayProvider(provider);
    setOverlayProvider(undefined);

    expect(getOverlayProvider()).not.toBe(provider);
  });
});

describe('fallback provider', () => {
  async function nextFrame(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  it('attaches a fixed-position content element to the body', () => {
    const layer = openFallback();

    expect(layer.contentElement.isConnected).toBe(true);
    expect(layer.contentElement.style.position).toBe('fixed');
  });

  it('applies className to the fixed layer wrapper', () => {
    const layer = openFallback(anchor(), {className: 'demo'});

    expect(layer.contentElement.classList.contains('demo')).toBe(true);
  });

  it('applies no sizing of its own', () => {
    const layer = openFallback();

    expect(layer.contentElement.style.maxHeight).toBe('');
    expect(layer.contentElement.style.overflow).toBe('');
  });

  it('removes the content element on close and reports the api reason', async () => {
    const layer = openFallback();
    const element = layer.contentElement;

    layer.close();

    await expect(layer.closed).resolves.toBe('api');
    expect(element.isConnected).toBe(false);
  });

  it('is idempotent on repeated close', async () => {
    const layer = openFallback();

    layer.close();
    expect(() => layer.close()).not.toThrow();
    await layer.closed;
  });

  it('reports the outside reason on outside pointerdown', async () => {
    const layer = openFallback();
    const element = layer.contentElement;

    document.body.dispatchEvent(new Event('pointerdown', {bubbles: true}));

    await expect(layer.closed).resolves.toBe('outside');
    expect(element.isConnected).toBe(false);
  });

  it('does not close on pointerdown inside the panel', () => {
    const layer = openFallback();

    layer.contentElement.dispatchEvent(new Event('pointerdown', {bubbles: true}));

    expect(layer.contentElement.isConnected).toBe(true);
  });

  it('treats the anchor as inside', () => {
    const trigger = anchor();
    const layer = openFallback(trigger);

    trigger.dispatchEvent(new Event('pointerdown', {bubbles: true, composed: true}));

    expect(layer.contentElement.isConnected).toBe(true);
  });

  it('reports the escape reason on Escape', async () => {
    const layer = openFallback();

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

    await expect(layer.closed).resolves.toBe('escape');
  });

  it('stays hidden until the first reposition', () => {
    expect(openFallback().contentElement.style.visibility).toBe('hidden');
  });

  it('positions against the anchor only when repositioned', () => {
    const trigger = anchor();

    trigger.getBoundingClientRect = () => ({bottom: 100, top: 68, left: 40, width: 200} as DOMRect);

    const layer = openFallback(trigger);

    layer.contentElement.appendChild(document.createElement('div'));
    layer.reposition();

    expect(layer.contentElement.style.top).toBe('108px');
    expect(layer.contentElement.style.left).toBe('40px');
    expect(layer.contentElement.style.visibility).toBe('visible');
  });

  it('uses the canonical flip order when the preferred side is clipped', () => {
    const trigger = anchor();

    trigger.getBoundingClientRect = () => ({bottom: 700, top: 668, left: 40, right: 240, width: 200} as DOMRect);

    const layer = openFallback(trigger);

    Object.defineProperty(layer.contentElement, 'offsetHeight', {configurable: true, value: 100});
    Object.defineProperty(layer.contentElement, 'offsetWidth', {configurable: true, value: 100});
    vi.stubGlobal('innerHeight', 768);
    vi.stubGlobal('innerWidth', 1024);
    layer.reposition();

    expect(layer.contentElement.style.top).toBe('560px');
  });

  it('sets no width of its own', () => {
    const trigger = anchor();

    trigger.getBoundingClientRect = () => ({bottom: 100, top: 68, left: 40, width: 60} as DOMRect);

    const layer = openFallback(trigger);

    layer.reposition();

    expect(layer.contentElement.style.width).toBe('');
  });

  it('stops repositioning after close', () => {
    const layer = openFallback();

    layer.close();

    expect(() => layer.reposition()).not.toThrow();
  });

  it('detaches its document and window listeners on close', async () => {
    const layer = openFallback();

    layer.close();
    await layer.closed;

    const survivor = openFallback();

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    await survivor.closed;

    expect(survivor.contentElement.isConnected).toBe(false);
  });

  it('opens a visible sheet with title and close chrome', () => {
    const layer = openFallback(anchor(), {presentation: 'sheet', title: 'Interface'});

    expect(layer.contentElement.isConnected).toBe(true);
    expect(layer.contentElement.parentElement?.parentElement?.classList.contains('mndw-ui-sheet')).toBe(true);
    expect(document.body.textContent).toContain('Interface');
    expect(document.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(layer.contentElement.style.visibility).toBe('');
    expect(layer.contentElement.style.position).toBe('');
    expect(document.querySelector('.mndw-ui-sheet__header mndw-icon')?.getAttribute('name')).toBe('x');
  });

  it('traps focus inside the sheet once it has rendered', async () => {
    const outside = document.createElement('button');

    document.body.appendChild(outside);

    const layer = openFallback(anchor(), {presentation: 'sheet', title: 'Interface'});
    const option = document.createElement('button');

    layer.contentElement.appendChild(option);
    await nextFrame();

    outside.focus();
    expect(layer.contentElement.closest('.mndw-ui-sheet')?.contains(deepActiveElement())).toBe(true);
    layer.close();
  });

  it('releases the trap on close without stealing focus back', async () => {
    const outside = document.createElement('button');

    document.body.appendChild(outside);

    const layer = openFallback(anchor(), {presentation: 'sheet'});

    await nextFrame();
    layer.close();
    outside.focus();
    expect(deepActiveElement()).toBe(outside);
  });

  it('lets content handle Tab first (select dismissal)', async () => {
    const layer = openFallback(anchor(), {presentation: 'sheet'});
    const option = document.createElement('button');

    layer.contentElement.appendChild(option);
    option.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        layer.close();
      }
    });
    await nextFrame();
    option.focus();
    option.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, composed: true, cancelable: true}));

    await expect(layer.closed).resolves.toBe('api');
  });

  it('does not trap a fallback sheet when trapFocus is false', async () => {
    const outside = document.createElement('button');

    document.body.appendChild(outside);

    const layer = openFallback(anchor(), {presentation: 'sheet', trapFocus: false});

    await nextFrame();
    outside.focus();
    expect(deepActiveElement()).toBe(outside);
    layer.close();
  });

  it('traps a fallback popover only when asked', async () => {
    const outside = document.createElement('button');

    document.body.appendChild(outside);

    const layer = openFallback(anchor(), {trapFocus: true});

    layer.contentElement.appendChild(document.createElement('button'));
    await nextFrame();
    outside.focus();
    expect(layer.contentElement.contains(deepActiveElement())).toBe(true);
    layer.close();
  });

  it('localizes generated sheet chrome', () => {
    setMndwUiLocale('ru');

    const layer = openFallback(anchor(), {presentation: 'sheet'});

    expect(document.querySelector('.mndw-ui-sheet__header span')?.textContent).toBe('Выберите вариант');
    expect(document.querySelector('[aria-label="Закрыть"]')).not.toBeNull();

    layer.setTitle?.('Custom title');
    expect(document.querySelector('.mndw-ui-sheet__header span')?.textContent).toBe('Custom title');
  });

  it('sizes a fallback sheet to content up to the viewport', () => {
    openFallback(anchor(), {presentation: 'sheet', title: 'Interface'});

    const surface = document.querySelector<HTMLElement>('.mndw-ui-sheet');
    const header = document.querySelector<HTMLElement>('.mndw-ui-sheet__header');
    const body = document.querySelector<HTMLElement>('.mndw-ui-sheet__body');

    expect(surface?.style.height).toBe('auto');
    expect(surface?.style.maxHeight).toBe('100dvh');
    expect(header?.style.flexShrink).toBe('0');
    expect(body?.style.maxHeight).toBe('');
    expect(body?.style.minHeight).toBe('0');
    expect(body?.style.overflow).toBe('hidden');
  });

  it('does not close a sheet from its surface but treats its anchor as outside', async () => {
    const trigger = anchor();
    const layer = openFallback(trigger, {presentation: 'sheet', title: 'Interface'});
    const surface = document.querySelector('.mndw-ui-sheet');

    if (!surface) {
      throw new Error('missing sheet surface');
    }

    surface.dispatchEvent(new Event('pointerdown', {bubbles: true, composed: true}));
    expect(layer.contentElement.isConnected).toBe(true);

    trigger.dispatchEvent(new Event('pointerdown', {bubbles: true, composed: true}));
    await expect(layer.closed).resolves.toBe('outside');
    expect(layer.contentElement.isConnected).toBe(false);
  });

  it('closes a sheet from its backdrop', async () => {
    const layer = openFallback(anchor(), {presentation: 'sheet', title: 'Interface'});
    const backdrop = document.querySelector('.mndw-ui-sheet__backdrop');

    if (!backdrop) {
      throw new Error('missing sheet backdrop');
    }

    backdrop.dispatchEvent(new Event('pointerdown', {bubbles: true, composed: true}));

    await expect(layer.closed).resolves.toBe('outside');
    expect(layer.contentElement.isConnected).toBe(false);
  });

  it('closes a sheet from Escape and removes the sheet root', async () => {
    const layer = openFallback(anchor(), {presentation: 'sheet', title: 'Interface'});
    const root = document.querySelector('.mndw-ui-sheet-root');

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

    await expect(layer.closed).resolves.toBe('escape');
    expect(root?.isConnected).toBe(false);
  });
});
