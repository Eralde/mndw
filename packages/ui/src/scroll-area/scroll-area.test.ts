import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MNDW_SCROLL_AREA_TAG, MndwScrollArea} from './scroll-area.js';

class TestResizeObserver {
  public static instances: TestResizeObserver[] = [];
  public readonly observed: Element[] = [];
  public disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  public observe(element: Element): void {
    this.observed.push(element);
  }

  public disconnect(): void {
    this.disconnected = true;
  }

  public trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

beforeAll(() => {
  if (!customElements.get(MNDW_SCROLL_AREA_TAG)) {
    customElements.define(MNDW_SCROLL_AREA_TAG, MndwScrollArea);
  }
});

beforeEach(() => {
  TestResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

interface Geometry {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  trackHeight: number;
  minThumb?: number;
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubRect(element: Element, produce: () => DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {configurable: true, value: produce});
}

async function mountWithGeometry(geometry: Geometry): Promise<MndwScrollArea> {
  const area = document.createElement(MNDW_SCROLL_AREA_TAG) as MndwScrollArea;
  const content = document.createElement('div');

  content.textContent = 'scroll content';
  area.appendChild(content);
  document.body.appendChild(area);
  await area.updateComplete;

  const viewport = area.viewportElement;
  const track = area.shadowRoot?.querySelector<HTMLElement>('[part="track"]');
  const thumb = area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
  const probe = area.shadowRoot?.querySelector<HTMLElement>('[data-measure="thumb-min"]');

  if (!viewport || !track || !thumb || !probe) {
    throw new Error('missing geometry elements');
  }

  Object.defineProperties(viewport, {
    clientHeight: {configurable: true, value: geometry.clientHeight},
    scrollHeight: {configurable: true, value: geometry.scrollHeight},
    scrollTop: {configurable: true, writable: true, value: geometry.scrollTop},
  });
  stubRect(track, () => rect(0, geometry.trackHeight));
  stubRect(probe, () => rect(0, geometry.minThumb ?? 24));
  stubRect(thumb, () => {
    const height = Number.parseFloat(thumb.style.height) || 0;
    const offset = /translateY\(([-\d.]+)px\)/.exec(thumb.style.transform);

    return rect(offset ? Number.parseFloat(offset[1]) : 0, height);
  });

  area.refresh();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  return area;
}

describe('<mndw-scroll-area>', () => {
  it('renders native viewport and bespoke scrollbar parts', async () => {
    const area = document.createElement(MNDW_SCROLL_AREA_TAG) as MndwScrollArea;

    document.body.appendChild(area);
    await area.updateComplete;

    expect(area.shadowRoot?.querySelector('[part="viewport"]')).not.toBeNull();
    expect(area.shadowRoot?.querySelector('[part="scrollbar"]')).not.toBeNull();
    expect(area.shadowRoot?.querySelector('[part="track"]')).not.toBeNull();
    expect(area.shadowRoot?.querySelector('[part="thumb"]')).not.toBeNull();
  });

  it('hides scrollbar when content fits', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 100, scrollTop: 0, trackHeight: 100});
    const scrollbar = area.shadowRoot?.querySelector<HTMLElement>('[part="scrollbar"]');

    expect(scrollbar?.style.display).toBe('none');
  });

  it('sizes and shows thumb only when content overflows', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 400, scrollTop: 0, trackHeight: 100});
    const thumb = area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
    const scrollbar = area.shadowRoot?.querySelector<HTMLElement>('[part="scrollbar"]');

    if (!thumb || !scrollbar) {
      throw new Error('missing scrollbar parts');
    }

    expect(scrollbar.style.display).not.toBe('none');
    expect(thumb.style.height).toBe('25px');
    expect(area.viewportElement?.classList.contains('viewport')).toBe(true);
  });

  it('clamps thumb to 24px and never beyond track length', async () => {
    const area = await mountWithGeometry({clientHeight: 10, scrollHeight: 10_000, scrollTop: 0, trackHeight: 12});

    expect(area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]')?.style.height).toBe('12px');
  });

  it('uses the measured minimum for thumb geometry', async () => {
    const area = await mountWithGeometry({
      clientHeight: 10,
      scrollHeight: 10_000,
      scrollTop: 0,
      trackHeight: 100,
      minThumb: 40,
    });

    expect(area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]')?.style.height).toBe('40px');
  });

  it('falls back to 24px when measured minimum is zero', async () => {
    const area = await mountWithGeometry({
      clientHeight: 10,
      scrollHeight: 10_000,
      scrollTop: 0,
      trackHeight: 100,
      minThumb: 0,
    });

    expect(area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]')?.style.height).toBe('24px');
  });

  it('handles empty content without invalid thumb geometry', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 0, scrollTop: 0, trackHeight: 100});
    const thumb = area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
    const scrollbar = area.shadowRoot?.querySelector<HTMLElement>('[part="scrollbar"]');

    expect(scrollbar?.style.display).toBe('none');
    expect(thumb?.style.height).not.toMatch(/NaN|Infinity/);
    expect(thumb?.style.transform).not.toMatch(/NaN|Infinity/);
  });

  it('recalculates geometry when refresh is called', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 100, scrollTop: 0, trackHeight: 100});
    const viewport = area.viewportElement;
    const scrollbar = area.shadowRoot?.querySelector<HTMLElement>('[part="scrollbar"]');

    if (!viewport || !scrollbar) {
      throw new Error('missing refresh elements');
    }

    Object.defineProperty(viewport, 'scrollHeight', {configurable: true, value: 400});
    area.refresh();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(scrollbar.style.display).not.toBe('none');
  });

  it('keeps scrollbar defaults at usage sites for ancestor overrides', () => {
    const styles = String(MndwScrollArea.styles);

    expect(styles).toContain('var(--mndw-scrollbar-thumb,');
    expect(styles).not.toMatch(/:host[^}]*--mndw-scrollbar-/);
  });

  it('refreshes geometry from viewport and content resize observers', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 100, scrollTop: 0, trackHeight: 100});
    const viewport = area.viewportElement;
    const scrollbar = area.shadowRoot?.querySelector<HTMLElement>('[part="scrollbar"]');
    const [viewportObserver, contentObserver] = TestResizeObserver.instances;

    if (!viewport || !scrollbar || !viewportObserver || !contentObserver) {
      throw new Error('missing resize observers');
    }

    expect(viewportObserver.observed).toContain(viewport);
    expect(contentObserver.observed).toHaveLength(1);

    Object.defineProperty(viewport, 'scrollHeight', {configurable: true, value: 400});
    viewportObserver.trigger();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(scrollbar.style.display).not.toBe('none');
  });

  it('retargets content observation on slotchange', async () => {
    const area = document.createElement(MNDW_SCROLL_AREA_TAG) as MndwScrollArea;
    const firstContent = document.createElement('div');
    const secondContent = document.createElement('div');

    area.appendChild(firstContent);
    document.body.appendChild(area);
    await area.updateComplete;

    const contentObserver = TestResizeObserver.instances[1];
    const slot = area.shadowRoot?.querySelector('slot');

    if (!contentObserver || !slot) {
      throw new Error('missing content observer');
    }

    expect(contentObserver.observed).toContain(firstContent);
    area.replaceChildren(secondContent);
    slot.dispatchEvent(new Event('slotchange'));

    expect(contentObserver.observed).toContain(secondContent);
  });

  it('disconnects observers and cancels pending refresh on disconnect', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 400, scrollTop: 0, trackHeight: 100});
    const [viewportObserver, contentObserver] = TestResizeObserver.instances;
    const viewport = area.viewportElement;

    if (!viewport) {
      throw new Error('missing viewport');
    }

    const removeEventListener = vi.spyOn(viewport, 'removeEventListener');
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');

    area.refresh();
    area.remove();

    expect(viewportObserver?.disconnected).toBe(true);
    expect(contentObserver?.disconnected).toBe(true);
    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(cancel).toHaveBeenCalled();
  });

  it('maps thumb drag to native scrollTop and clamps at the end', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 400, scrollTop: 0, trackHeight: 100});
    const thumb = area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
    const viewport = area.viewportElement;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();

    if (!thumb || !viewport) {
      throw new Error('missing scroll parts');
    }

    Object.defineProperties(thumb, {
      setPointerCapture: {configurable: true, value: setPointerCapture},
      releasePointerCapture: {configurable: true, value: releasePointerCapture},
    });

    thumb.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientY: 5, pointerId: 1}));
    thumb.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientY: 80, pointerId: 1}));

    expect(viewport.scrollTop).toBe(300);
    expect(thumb.classList.contains('dragging')).toBe(true);
    expect(area.classList.contains('dragging')).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(1);

    thumb.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientY: 400, pointerId: 1}));
    expect(viewport.scrollTop).toBe(300);

    thumb.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientY: 400, pointerId: 1}));

    expect(thumb.classList.contains('dragging')).toBe(false);
    expect(area.classList.contains('dragging')).toBe(false);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('clamps thumb drag at the start', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 400, scrollTop: 200, trackHeight: 100});
    const thumb = area.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
    const viewport = area.viewportElement;

    if (!thumb || !viewport) {
      throw new Error('missing scroll parts');
    }

    thumb.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientY: 55, pointerId: 2}));
    thumb.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientY: -100, pointerId: 2}));

    expect(viewport.scrollTop).toBe(0);
  });

  it('centres thumb on track press and continues as drag', async () => {
    const area = await mountWithGeometry({clientHeight: 100, scrollHeight: 400, scrollTop: 0, trackHeight: 100});
    const track = area.shadowRoot?.querySelector<HTMLElement>('[part="track"]');
    const setPointerCapture = vi.fn();

    if (!track) {
      throw new Error('missing track');
    }

    Object.defineProperty(track, 'setPointerCapture', {configurable: true, value: setPointerCapture});
    track.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientY: 75, pointerId: 3}));

    expect(area.viewportElement?.scrollTop).toBe(250);
    expect(area.classList.contains('dragging')).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(3);
  });
});
