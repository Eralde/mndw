// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {defineComponents, mount as mountComponent, settle} from '../testing/index.js';
import {deepActiveElement} from '../focus.js';
import {MNDW_TOOLTIP_TAG, MndwTooltip} from './tooltip.js';

defineComponents([MNDW_TOOLTIP_TAG, MndwTooltip]);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(html: string): Promise<MndwTooltip> {
  const element = await mountComponent(html, MNDW_TOOLTIP_TAG);

  await settle(element, 2);

  return element;
}

function trigger(element: MndwTooltip): HTMLElement {
  const found = element.querySelector<HTMLElement>('button');

  if (!found) {
    throw new Error('missing trigger');
  }

  return found;
}

function bubble(element: MndwTooltip): HTMLElement | null {
  return element.shadowRoot?.querySelector<HTMLElement>('[part="tooltip"]') ?? null;
}

function describedBy(element: MndwTooltip): string[] {
  return (trigger(element).getAttribute('aria-describedby') ?? '').split(/\s+/u).filter((token) => token !== '');
}

/**
 * Fake timers only after the real ones have done the mounting: `settle` needs a real macrotask, and
 * the show delay is the only timer the visibility tests actually care about.
 */
async function mountOpenable(html: string): Promise<MndwTooltip> {
  const element = await mount(html);

  vi.useFakeTimers();

  return element;
}

async function show(element: MndwTooltip, event = 'pointerenter'): Promise<void> {
  trigger(element).dispatchEvent(new Event(event, {bubbles: true, composed: true}));
  await vi.advanceTimersByTimeAsync(element.delay);
  await element.updateComplete;
}

async function dispatch(element: MndwTooltip, event: string): Promise<void> {
  trigger(element).dispatchEvent(new Event(event, {bubbles: true, composed: true}));
  await element.updateComplete;
}

async function dispatchBubble(element: MndwTooltip, event: string): Promise<void> {
  const node = bubble(element);

  if (!node) {
    throw new Error('missing bubble');
  }

  node.dispatchEvent(new Event(event, {bubbles: true, composed: true}));
  await element.updateComplete;
}

describe('<mndw-tooltip> semantics', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-tooltip><button>Restart</button></mndw-tooltip>');

    expect(element.text).toBe('');
    expect(element.placement).toBe('top');
    expect(element.delay).toBe(500);
    expect(element.hideDelay).toBe(300);
  });

  it('generates a stable host id and keeps a consumer one', async () => {
    const generated = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');

    expect(generated.id).toMatch(/^mndw-tooltip-\d+$/u);

    const supplied = await mount(
      '<mndw-tooltip id="mine" text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    expect(supplied.id).toBe('mine');
  });

  it('carries the tooltip role only while text is non-empty', async () => {
    const element = await mount('<mndw-tooltip><button>Restart</button></mndw-tooltip>');

    expect(element.hasAttribute('role')).toBe(false);

    element.text = 'Restarts now';
    await settle(element, 2);

    expect(element.getAttribute('role')).toBe('tooltip');

    element.text = '';
    await settle(element, 2);

    expect(element.hasAttribute('role')).toBe(false);
  });

  it('renders nothing for empty text and the bubble for non-empty text', async () => {
    const element = await mount('<mndw-tooltip><button>Restart</button></mndw-tooltip>');

    expect(bubble(element)).toBeNull();

    element.text = 'Restarts now';
    await settle(element, 2);

    expect(bubble(element)?.textContent?.trim()).toBe('Restarts now');
  });

  it('reflects placement, delay, and hide delay as configuration', async () => {
    const element = await mount(
      '<mndw-tooltip text="Restarts now" placement="right" delay="0" hide-delay="0"><button>Restart</button></mndw-tooltip>',
    );

    expect(element.placement).toBe('right');
    expect(element.delay).toBe(0);
    expect(element.hideDelay).toBe(0);

    element.placement = 'bottom';
    element.delay = 200;
    element.hideDelay = 240;
    await settle(element, 2);

    expect(element.getAttribute('placement')).toBe('bottom');
    expect(element.getAttribute('delay')).toBe('200');
    expect(element.getAttribute('hide-delay')).toBe('240');
  });

  it('is not form-associated', () => {
    expect((MndwTooltip as unknown as {formAssociated?: boolean}).formAssociated).toBeUndefined();
  });
});

describe('<mndw-tooltip> trigger ownership', () => {
  it('describes the first assigned element', async () => {
    const element = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');

    expect(describedBy(element)).toEqual([element.id]);
  });

  it('warns once about extra assigned elements and ignores them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const element = await mount(`
      <mndw-tooltip text="Restarts now">
        <button>Restart</button>
        <span id="extra">Extra</span>
      </mndw-tooltip>
    `);

    expect(describedBy(element)).toEqual([element.id]);
    expect(element.querySelector('#extra')?.hasAttribute('aria-describedby')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    element.text = 'Restarts the device now';
    await settle(element, 2);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('preserves consumer description tokens', async () => {
    const element = await mount(`
      <mndw-tooltip text="Restarts now">
        <button aria-describedby="hint other">Restart</button>
      </mndw-tooltip>
    `);

    expect(describedBy(element)).toEqual(['hint', 'other', element.id]);
  });

  it('removes only its own token when text empties', async () => {
    const element = await mount(`
      <mndw-tooltip text="Restarts now">
        <button aria-describedby="hint">Restart</button>
      </mndw-tooltip>
    `);

    element.text = '';
    await settle(element, 2);

    expect(describedBy(element)).toEqual(['hint']);
  });

  it('drops the attribute entirely when it owned the only token', async () => {
    const element = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');

    element.text = '';
    await settle(element, 2);

    expect(trigger(element).hasAttribute('aria-describedby')).toBe(false);
  });

  it('rewires when the host id changes', async () => {
    const element = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');

    element.id = 'renamed';
    await settle(element, 2);

    expect(describedBy(element)).toEqual(['renamed']);
  });

  it('rewires when a consumer rewrites the trigger description', async () => {
    const element = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');

    trigger(element).setAttribute('aria-describedby', 'consumer');
    await settle(element, 2);

    expect(describedBy(element)).toEqual(['consumer', element.id]);
  });

  it('cleans the outgoing trigger when it is replaced', async () => {
    const element = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');
    const outgoing = trigger(element);
    const incoming = document.createElement('button');

    incoming.textContent = 'Reboot';
    outgoing.replaceWith(incoming);
    await settle(element, 2);

    expect(outgoing.hasAttribute('aria-describedby')).toBe(false);
    expect(incoming.getAttribute('aria-describedby')).toBe(element.id);
  });

  it('releases its token on disconnect', async () => {
    const element = await mount(`
      <mndw-tooltip text="Restarts now">
        <button aria-describedby="hint">Restart</button>
      </mndw-tooltip>
    `);
    const button = trigger(element);

    element.remove();
    await settle(element, 2);

    expect((button.getAttribute('aria-describedby') ?? '').split(/\s+/u)).toEqual(['hint']);
  });
});

describe('<mndw-tooltip> visibility', () => {
  it('shows on hover after the delay and closes after the hide delay on pointer leave', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    trigger(element).dispatchEvent(new Event('pointerenter', {bubbles: true, composed: true}));
    await vi.advanceTimersByTimeAsync(element.delay - 1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    await dispatch(element, 'pointerleave');

    expect(element.hasAttribute('open')).toBe(true);

    await vi.advanceTimersByTimeAsync(element.hideDelay - 1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('cancels a pending show when the pointer leaves first', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    trigger(element).dispatchEvent(new Event('pointerenter', {bubbles: true, composed: true}));
    trigger(element).dispatchEvent(new Event('pointerleave', {bubbles: true, composed: true}));
    await vi.advanceTimersByTimeAsync(element.delay * 2);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('keeps the tooltip open when the pointer moves from the trigger onto the bubble', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    await dispatch(element, 'pointerleave');
    await dispatchBubble(element, 'pointerenter');
    await vi.advanceTimersByTimeAsync(element.hideDelay * 2);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    await dispatchBubble(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(element.hideDelay);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('cancels the pending close when the pointer re-enters the trigger', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    await dispatch(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(element.hideDelay - 1);
    await dispatch(element, 'pointerenter');
    await vi.advanceTimersByTimeAsync(element.hideDelay * 2);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);
  });

  it('treats a negative hide delay as zero', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now" hide-delay="-50"><button>Restart</button></mndw-tooltip>',
    );

    expect(element.hideDelay).toBe(-50);

    await show(element);
    await dispatch(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('falls back to the default hide delay when hide-delay is unparseable or removed', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now" hide-delay="abc"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    await dispatch(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(299);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);

    element.removeAttribute('hide-delay');
    await element.updateComplete;

    expect(element.hideDelay).toBeNull();

    await show(element);
    await dispatch(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(300);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('does not close while a selection drag is in progress, even if the pointer leaves the bubble', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    await dispatch(element, 'pointerleave');
    await dispatchBubble(element, 'pointerenter');
    await dispatchBubble(element, 'pointerdown');
    await dispatchBubble(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(element.hideDelay * 2);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    document.dispatchEvent(new Event('pointerup', {bubbles: true}));
    await element.updateComplete;

    await vi.advanceTimersByTimeAsync(element.hideDelay - 1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('does not close on focusout while the pointer is down inside the bubble', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element, 'focusin');
    await dispatchBubble(element, 'pointerenter');
    await dispatchBubble(element, 'pointerdown');

    // A mousedown in the bubble blurs the trigger; the region, not focus, must govern closing.
    await dispatch(element, 'focusout');

    expect(element.hasAttribute('open')).toBe(true);

    document.dispatchEvent(new Event('pointerup', {bubbles: true}));
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    await dispatchBubble(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(element.hideDelay);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('does not close on focusout while the pointer is over the trigger', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element, 'focusin');
    await dispatch(element, 'pointerenter');
    await dispatch(element, 'focusout');

    expect(element.hasAttribute('open')).toBe(true);

    await dispatch(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(element.hideDelay);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('treats pointercancel like pointerup and does not leave the tooltip stuck open', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    await dispatch(element, 'pointerleave');
    await dispatchBubble(element, 'pointerenter');
    await dispatchBubble(element, 'pointerdown');
    await dispatchBubble(element, 'pointerleave');
    await vi.advanceTimersByTimeAsync(element.hideDelay * 2);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(true);

    // A pan or scroll ends a touch/pen drag with pointercancel and no pointerup.
    document.dispatchEvent(new Event('pointercancel', {bubbles: true}));
    await element.updateComplete;

    await vi.advanceTimersByTimeAsync(element.hideDelay);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('shows on focus and hides on blur', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element, 'focusin');

    expect(element.hasAttribute('open')).toBe(true);

    await dispatch(element, 'focusout');

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('hides on Escape without consuming the key for anyone else', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);

    const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true, cancelable: true});

    trigger(element).dispatchEvent(escape);
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
  });

  it('dismisses on Escape even when the target stops propagation', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );
    const button = trigger(element);

    await show(element);

    // The column menu stops propagation of Escape; the document listener must run in capture
    // phase so such a target cannot swallow the dismissal.
    button.addEventListener('keydown', (event) => {
      event.stopPropagation();
    });
    button.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}));
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('keeps focus on the trigger when Escape hides it', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );
    const button = trigger(element);

    button.focus();
    await show(element, 'focusin');
    button.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}));
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
    expect(deepActiveElement()).toBe(button);
  });

  it('hides immediately on Escape while the pointer is over the bubble', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    await dispatch(element, 'pointerleave');
    await dispatchBubble(element, 'pointerenter');

    expect(element.hasAttribute('open')).toBe(true);

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        composed: true,
      }),
    );
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('never opens while text is empty', async () => {
    const element = await mountOpenable('<mndw-tooltip><button>Restart</button></mndw-tooltip>');

    await show(element);

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('closes when text empties while open', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>',
    );

    await show(element);
    expect(element.hasAttribute('open')).toBe(true);

    element.text = '';
    await element.updateComplete;

    expect(element.hasAttribute('open')).toBe(false);
  });

  it('positions the bubble from the trigger rect on show', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now" placement="bottom"><button>Restart</button></mndw-tooltip>',
    );
    const node = bubble(element);

    if (!node) {
      throw new Error('missing bubble');
    }

    trigger(element).getBoundingClientRect = (): DOMRect => new DOMRect(600, 400, 60, 20);
    node.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 40);

    await show(element);

    expect(node.style.top).toBe('428px');
    expect(node.style.left).toBe('580px');
    expect(element.getAttribute('data-placement')).toBe('bottom');
  });

  it('flips a clipped placement and reports the side it used', async () => {
    const element = await mountOpenable(
      '<mndw-tooltip text="Restarts now" placement="top"><button>Restart</button></mndw-tooltip>',
    );
    const node = bubble(element);

    if (!node) {
      throw new Error('missing bubble');
    }

    trigger(element).getBoundingClientRect = (): DOMRect => new DOMRect(600, 4, 60, 20);
    node.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 40);

    await show(element);

    expect(element.getAttribute('data-placement')).toBe('bottom');
    expect(node.style.top).toBe('32px');
  });

  it('exposes the bubble as a part that stays in the accessibility tree while closed', async () => {
    const element = await mount('<mndw-tooltip text="Restarts now"><button>Restart</button></mndw-tooltip>');

    // The description is resolved from this text, so the closed state has to be invisible without
    // leaving the accessibility tree — opacity, not `display` or `hidden`.
    expect(bubble(element)?.hidden).toBe(false);
    expect(MndwTooltip.styles.cssText).toContain('opacity: 0;');
    expect(MndwTooltip.styles.cssText).toContain(':host([open]) [part=\'tooltip\']');
  });

  it('keeps the open bubble interactive and its text selectable, and the closed one inert', () => {
    const cssText = MndwTooltip.styles.cssText;

    expect(cssText).toContain('user-select: text;');
    expect(cssText).toContain('pointer-events: none;');
    expect(cssText).toContain('pointer-events: auto;');
  });
});
