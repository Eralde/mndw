// @vitest-environment happy-dom
/* eslint id-blacklist: 0 */
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import MobileOrderOverlay from './MobileOrderOverlay.svelte';

type MndwButtonHost = HTMLElement & {disabled: boolean};
import MobileOrderOverlayTestHost from './MobileOrderOverlayTestHost.svelte';

const CARDS = [
  {id: 'widget-clock:1', label: 'Clock'},
  {id: 'widget-traffic:1', label: 'TX/RX Traffic 1'},
  {id: 'widget-traffic:2', label: 'TX/RX Traffic 2'},
];

interface TestHost {
  close: () => void;
  reopen: (cards: {id: string; label: string}[]) => void;
}

function mountOverlay(props: Partial<{open: boolean; onCommit: (order: string[]) => void}> = {}) {
  const onCommit = props.onCommit ?? vi.fn();
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(MobileOrderOverlay, {
    target,
    props: {open: props.open ?? true, cards: CARDS, onCommit},
  });

  flushSync();

  return {component, target, onCommit};
}

const cardLabels = (target: HTMLElement): string[] =>
  [...target.querySelectorAll('.mndw-order-card__label')].map((el) => el.textContent ?? '');

describe('MobileOrderOverlay', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one card per widget instance with distinguishable duplicate labels', () => {
    const {component, target} = mountOverlay();

    expect(cardLabels(target)).toEqual(['Clock', 'TX/RX Traffic 1', 'TX/RX Traffic 2']);

    void unmount(component);
  });

  it('keeps focus inside the open overlay', () => {
    const outside = document.createElement('button');

    document.body.appendChild(outside);

    const {component, target} = mountOverlay({open: true});

    outside.focus();

    expect(target.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    void unmount(component);
    outside.remove();
  });

  it('move-down reorders the draft without committing until close', () => {
    const {component, target, onCommit} = mountOverlay();

    target
      .querySelectorAll<HTMLElement>('[aria-label="Move Clock down"]')[0]
      ?.click();
    flushSync();

    expect(cardLabels(target)).toEqual(['TX/RX Traffic 1', 'Clock', 'TX/RX Traffic 2']);
    expect(onCommit).not.toHaveBeenCalled();

    void unmount(component);
  });

  it('disables move-up on the first card and move-down on the last', () => {
    const {component, target} = mountOverlay();
    const ups = target.querySelectorAll<MndwButtonHost>('.mndw-order-card__moves mndw-button:first-child');
    const downs = target.querySelectorAll<MndwButtonHost>('.mndw-order-card__moves mndw-button:last-child');

    expect(ups[0]?.disabled).toBe(true);
    expect(downs[downs.length - 1]?.disabled).toBe(true);

    void unmount(component);
  });

  it.each([
    [
      'close button',
      (target: HTMLElement) => target.querySelector<HTMLElement>('.mndw-floating-panel__close')?.click(),
    ],
    ['backdrop', (target: HTMLElement) => target.querySelector<HTMLElement>('.mndw-floating-panel-backdrop')?.click()],
    ['Escape', (target: HTMLElement) =>
      target.querySelector<HTMLElement>('.mndw-floating-panel')?.dispatchEvent(
        new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}),
      )],
  ])('commits the draft order on %s', (_path, close) => {
    const {component, target, onCommit} = mountOverlay();

    target.querySelectorAll<HTMLElement>('[aria-label="Move Clock down"]')[0]?.click();
    flushSync();
    close(target);
    flushSync();

    expect(onCommit).toHaveBeenCalledWith(['widget-traffic:1', 'widget-clock:1', 'widget-traffic:2']);

    void unmount(component);
  });

  it('reopening refreshes the draft from the current cards prop', () => {
    const onCommit = vi.fn();
    const target = document.createElement('div');

    document.body.appendChild(target);

    const host = mount(MobileOrderOverlayTestHost, {
      target,
      props: {cards: CARDS, onCommit},
    }) as unknown as TestHost;

    flushSync();

    host.close();
    flushSync();
    host.reopen([CARDS[1], CARDS[0], CARDS[2]]);
    flushSync();

    expect(cardLabels(target)).toEqual(['TX/RX Traffic 1', 'Clock', 'TX/RX Traffic 2']);

    void unmount(host);
  });

  it('renders shared arrow icons on the move buttons', async () => {
    const {component, target} = mountOverlay();
    const ups = target.querySelectorAll<MndwButtonHost>('.mndw-order-card__moves mndw-button:first-child');
    const downs = target.querySelectorAll<MndwButtonHost>('.mndw-order-card__moves mndw-button:last-child');

    await Promise.resolve();

    expect(ups[0]?.querySelector('mndw-icon')?.getAttribute('name')).toBe('arrow-up');
    expect(downs[0]?.querySelector('mndw-icon')?.getAttribute('name')).toBe('arrow-down');

    void unmount(component);
  });

  it('pointer drag on the handle reorders across card midpoints', () => {
    const {component, target} = mountOverlay();
    const handle = target.querySelectorAll<HTMLElement>('.mndw-order-card__handle')[0];
    const cards = target.querySelectorAll<HTMLElement>('.mndw-order-card');

    vi.spyOn(cards[1], 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 60,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);

    const PointerEventConstructor = globalThis.PointerEvent ?? MouseEvent;

    handle?.dispatchEvent(new PointerEventConstructor('pointerdown', {bubbles: true}));
    handle?.dispatchEvent(new PointerEventConstructor('pointermove', {bubbles: true, clientY: 50}));
    handle?.dispatchEvent(new PointerEventConstructor('pointerup', {bubbles: true}));
    flushSync();

    expect(cardLabels(target)).toEqual(['TX/RX Traffic 1', 'Clock', 'TX/RX Traffic 2']);

    void unmount(component);
  });
});
