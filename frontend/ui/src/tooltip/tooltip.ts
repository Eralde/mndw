import {LitElement, type PropertyDeclarations, type TemplateResult, css, html, nothing} from 'lit';
import {type TooltipPlacement, computeTooltipCoords} from '../position/position.js';
import {hostTypography} from '../styles/base.js';

export const MNDW_TOOLTIP_TAG = 'mndw-tooltip';

export type MndwTooltipPlacement = TooltipPlacement;

const DESCRIBED_BY = 'aria-describedby';
const TOKEN_SEPARATOR = /\s+/u;
const DEFAULT_DELAY = 500;
// Long enough for slow, deliberate pointer movement (2px per frame) to cross the 8px gap between
// trigger and bubble, short enough not to leave the tooltip hanging after the pointer has left.
const DEFAULT_HIDE_DELAY = 300;

let nextTooltipId = 0;

function tokensOf(element: Element): string[] {
  return (element.getAttribute(DESCRIBED_BY) ?? '').split(TOKEN_SEPARATOR).filter((token) => token !== '');
}

/**
 * Describes its first slotted element. The host — not the bubble — carries `role="tooltip"` and the
 * id, because an `aria-describedby` token cannot cross a shadow boundary to reach the bubble; the
 * trigger therefore sits inside the described subtree, which is why its own name is announced first
 * and this text second.
 *
 * The trigger and the bubble form one hover region: leaving the trigger toward the bubble does not
 * close it, leaving both starts the `hideDelay` countdown, and re-entering either cancels it. The
 * open bubble takes pointer events and its text is selectable, so long content can be read and
 * copied with the mouse.
 */
export class MndwTooltip extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    text: {type: String},
    placement: {type: String, reflect: true},
    delay: {type: Number, reflect: true},
    hideDelay: {type: Number, reflect: true, attribute: 'hide-delay'},
    // Internal, so Lit writes no attribute for it; `updated` writes `open` by hand as the styling
    // hook, the same way the semantic controls write their host state.
    visible: {type: Boolean, state: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: contents;
    }

    /*
     * Closed means invisible, never removed: the description is resolved from this text, so
     * \`display: none\` or \`hidden\` would leave the trigger describing nothing. The closed state
     * also takes no pointer events, so it never blocks the page beneath it; only the open state
     * below turns interactivity back on.
     */
    [part='tooltip'] {
      position: fixed;
      z-index: 1000;
      max-width: 15rem;
      padding: var(--mndw-space-1) var(--mndw-space-2);
      border: var(--mndw-border-w) solid var(--mndw-border);
      border-radius: var(--mndw-radius-sm);
      background: var(--mndw-surface-raised);
      box-shadow: var(--mndw-shadow-2);
      color: var(--mndw-text);
      font-size: var(--mndw-text-xs);
      line-height: var(--mndw-leading);
      opacity: 0;
      pointer-events: none;
      user-select: text;
      transition: opacity var(--mndw-duration-fast) var(--mndw-easing);
    }

    :host([open]) [part='tooltip'] {
      opacity: 1;
      pointer-events: auto;
    }
  `;

  declare public text: string;
  declare public placement: MndwTooltipPlacement;
  declare public delay: number;
  declare public hideDelay: number;
  declare private visible: boolean;

  private readonly observer: MutationObserver;
  private trigger: Element | null = null;
  private bubbleNode: HTMLElement | null = null;
  private ownedToken: string | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private selecting = false;
  private pointerOverTrigger = false;
  private pointerOverBubble = false;
  private warnedExtras = false;

  constructor() {
    super();
    this.text = '';
    this.placement = 'top';
    this.delay = DEFAULT_DELAY;
    this.hideDelay = DEFAULT_HIDE_DELAY;
    this.visible = false;
    this.observer = new MutationObserver(this.onMutations);
  }

  public override connectedCallback(): void {
    super.connectedCallback();

    if (this.id === '') {
      nextTooltipId += 1;
      this.id = `mndw-tooltip-${nextTooltipId}`;
    }

    // The trigger, its own description, and this host's id are all inputs to the wiring, and none
    // arrives as a property change. `childList` rather than `slotchange` is what watches the
    // trigger: a slot change also fires for the first render, where the trigger is already wired,
    // and answering that with an update would schedule one cycle per mount for nothing.
    this.observer.observe(this, {attributes: true, attributeFilter: ['id'], childList: true});

    // Escape must dismiss from anywhere — with the pointer over the trigger or bubble, not only
    // with focus inside the trigger (WCAG 1.4.13 "Dismissible") — and a selection drag can end
    // anywhere, so both are watched at the document level. Capture phase, so an ancestor that
    // stops propagation of Escape (the column menu does) cannot swallow the dismissal; the
    // handler never consumes the key. `pointercancel` ends a drag exactly like `pointerup` (a
    // pan or scroll from a touch or pen down otherwise leaves no up event).
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('pointercancel', this.onPointerUp);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancelShow();
    this.cancelHide();
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('pointercancel', this.onPointerUp);
    this.observer.disconnect();
    this.releaseTrigger();
    this.selecting = false;
    this.pointerOverTrigger = false;
    this.pointerOverBubble = false;
    this.visible = false;
  }

  protected override render(): TemplateResult {
    return html`
      <slot></slot>
      ${this.text ? html`<div part="tooltip" role="none">${this.text}</div>` : nothing}
    `;
  }

  /**
   * Emptying `text` closes an open tooltip and cancels a pending one. Doing it here rather than in
   * `updated` keeps the write inside the current update instead of scheduling another.
   */
  protected override willUpdate(): void {
    if (!this.text) {
      this.cancelShow();
      this.cancelHide();
      this.visible = false;
    }
  }

  protected override updated(): void {
    if (!this.isConnected) {
      return;
    }

    if (this.text) {
      this.setAttribute('role', 'tooltip');
    } else {
      this.removeAttribute('role');
    }

    this.toggleAttribute('open', this.visible);
    this.wireTrigger();
    this.wireBubble();
  }

  private bubble(): HTMLElement | null {
    return this.renderRoot.querySelector('[part="tooltip"]');
  }

  private assignedTrigger(): Element | null {
    const slot = this.renderRoot.querySelector('slot');
    const elements = slot?.assignedElements() ?? [];

    if (elements.length > 1 && !this.warnedExtras) {
      this.warnedExtras = true;
      console.warn(`<${MNDW_TOOLTIP_TAG} id="${this.id}"> takes one trigger element; the rest are ignored.`);
    }

    return elements[0] ?? null;
  }

  private wireTrigger(): void {
    const trigger = this.assignedTrigger();

    if (trigger !== this.trigger) {
      this.releaseTrigger();
      this.trigger = trigger;

      if (trigger) {
        this.observer.observe(trigger, {attributes: true, attributeFilter: [DESCRIBED_BY]});
        trigger.addEventListener('pointerenter', this.onTriggerEnter);
        trigger.addEventListener('focusin', this.onShowIntent);
        trigger.addEventListener('pointerleave', this.onTriggerLeave);
        trigger.addEventListener('focusout', this.onFocusOut);
      }
    }

    if (!trigger) {
      return;
    }

    const wanted = this.text ? this.id : null;

    if (wanted === null) {
      this.writeTokens(trigger, tokensOf(trigger).filter((token) => token !== this.ownedToken));
      this.ownedToken = null;

      return;
    }

    // Everything the consumer put there is kept; only this component's own token is managed.
    const kept = tokensOf(trigger).filter((token) => token !== this.ownedToken && token !== wanted);

    this.writeTokens(trigger, [...kept, wanted]);
    this.ownedToken = wanted;
  }

  /**
   * The bubble only exists while `text` is non-empty and Lit recreates it when that flips, so its
   * hover listeners follow the node instead of being bound once. Pointer enter/leave do not
   * bubble, which is why they are bound to the bubble itself, like the trigger's.
   */
  private wireBubble(): void {
    const bubble = this.bubble();

    if (bubble === this.bubbleNode) {
      return;
    }

    if (this.bubbleNode) {
      this.bubbleNode.removeEventListener('pointerenter', this.onBubbleEnter);
      this.bubbleNode.removeEventListener('pointerleave', this.onBubbleLeave);
      this.bubbleNode.removeEventListener('pointerdown', this.onBubblePointerDown);
    }

    // The old node is gone, so the pointer cannot still be over it.
    this.pointerOverBubble = false;
    this.bubbleNode = bubble;

    if (bubble) {
      bubble.addEventListener('pointerenter', this.onBubbleEnter);
      bubble.addEventListener('pointerleave', this.onBubbleLeave);
      bubble.addEventListener('pointerdown', this.onBubblePointerDown);
    }
  }

  private writeTokens(trigger: Element, tokens: readonly string[]): void {
    if (tokens.length === 0) {
      trigger.removeAttribute(DESCRIBED_BY);

      return;
    }

    const value = tokens.join(' ');

    if (trigger.getAttribute(DESCRIBED_BY) !== value) {
      trigger.setAttribute(DESCRIBED_BY, value);
    }
  }

  private releaseTrigger(): void {
    const trigger = this.trigger;

    if (trigger) {
      trigger.removeEventListener('pointerenter', this.onTriggerEnter);
      trigger.removeEventListener('focusin', this.onShowIntent);
      trigger.removeEventListener('pointerleave', this.onTriggerLeave);
      trigger.removeEventListener('focusout', this.onFocusOut);
    }

    if (trigger && this.ownedToken !== null) {
      this.writeTokens(trigger, tokensOf(trigger).filter((token) => token !== this.ownedToken));
    }

    this.ownedToken = null;
    this.trigger = null;
    // The trigger the pointer sat on is gone, so the pointer cannot still be over it.
    this.pointerOverTrigger = false;
  }

  private readonly onMutations = (): void => {
    this.requestUpdate();
  };

  private readonly onShowIntent = (): void => {
    this.cancelHide();

    if (!this.text || this.visible || this.showTimer !== null) {
      return;
    }

    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.show();
    }, Math.max(this.delay, 0));
  };

  private readonly onTriggerEnter = (): void => {
    this.pointerOverTrigger = true;
    this.onShowIntent();
  };

  private readonly onTriggerLeave = (): void => {
    this.pointerOverTrigger = false;
    this.cancelShow();
    this.scheduleHide();
  };

  private readonly onBubbleEnter = (): void => {
    this.pointerOverBubble = true;
    this.cancelHide();
  };

  private readonly onBubbleLeave = (): void => {
    this.pointerOverBubble = false;
    this.scheduleHide();
  };

  private readonly onBubblePointerDown = (): void => {
    this.selecting = true;
    this.cancelHide();
  };

  /**
   * A selection drag may end inside the bubble (stay open) or outside it (the pointer has left
   * the hover region for good — close after the usual delay). While the drag is in progress the
   * bubble's own leave events must not close it, hence the flag.
   */
  private readonly onPointerUp = (): void => {
    if (!this.selecting) {
      return;
    }

    this.selecting = false;

    if (!this.pointerOverTrigger && !this.pointerOverBubble) {
      this.scheduleHide();
    }
  };

  private readonly onFocusOut = (): void => {
    // Pressing inside the bubble blurs the trigger in Chromium — the bubble is not focusable, so
    // focus falls back to <body>. With the pointer still in the hover region (or down inside the
    // bubble), the region — not focus — must govern closing, otherwise the text cannot be
    // selected. Keyboard-only blur still closes immediately.
    if (this.selecting || this.pointerOverTrigger || this.pointerOverBubble) {
      return;
    }

    this.cancelShow();
    this.cancelHide();
    this.hide();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Dismissal only: the key belongs to whatever else is listening, such as a dialog.
    if (event.key === 'Escape') {
      this.cancelShow();
      this.cancelHide();
      this.hide();
    }
  };

  private cancelShow(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private scheduleHide(): void {
    if (this.selecting || !this.visible || this.hideTimer !== null) {
      return;
    }

    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, this.hideDelayValue());
  }

  /**
   * `hide-delay` may be removed (property becomes `null`) or unparseable (`NaN`); both mean
   * "use the default". Negative values mean "close as soon as the pointer leaves".
   */
  private hideDelayValue(): number {
    return Number.isFinite(this.hideDelay) ? Math.max(this.hideDelay, 0) : DEFAULT_HIDE_DELAY;
  }

  private show(): void {
    if (!this.text || !this.isConnected) {
      return;
    }

    this.visible = true;
    this.position();
  }

  private hide(): void {
    this.cancelShow();
    this.cancelHide();
    this.selecting = false;
    this.visible = false;
  }

  private position(): void {
    const bubble = this.bubble();

    if (!this.trigger || !bubble) {
      return;
    }

    const anchor = this.trigger.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const coords = computeTooltipCoords(
      anchor,
      {width: size.width, height: size.height},
      this.placement,
    );

    bubble.style.top = `${coords.top}px`;
    bubble.style.left = `${coords.left}px`;
    // The resolved side, which may differ from `placement` after a flip.
    this.setAttribute('data-placement', coords.placement);
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-tooltip': MndwTooltip;
  }
}
