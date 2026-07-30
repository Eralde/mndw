import {LitElement, type PropertyDeclarations, type TemplateResult, css, html, nothing} from 'lit';
import {type TooltipPlacement, computeTooltipCoords} from '../position/position.js';
import {hostTypography} from '../styles/base.js';

export const MNDW_TOOLTIP_TAG = 'mndw-tooltip';

export type MndwTooltipPlacement = TooltipPlacement;

const DESCRIBED_BY = 'aria-describedby';
const TOKEN_SEPARATOR = /\s+/u;
const DEFAULT_DELAY = 500;

let nextTooltipId = 0;

function tokensOf(element: Element): string[] {
  return (element.getAttribute(DESCRIBED_BY) ?? '').split(TOKEN_SEPARATOR).filter((token) => token !== '');
}

/**
 * Describes its first slotted element. The host — not the bubble — carries `role="tooltip"` and the
 * id, because an `aria-describedby` token cannot cross a shadow boundary to reach the bubble; the
 * trigger therefore sits inside the described subtree, which is why its own name is announced first
 * and this text second.
 */
export class MndwTooltip extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    text: {type: String},
    placement: {type: String, reflect: true},
    delay: {type: Number, reflect: true},
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
     * \`display: none\` or \`hidden\` would leave the trigger describing nothing.
     */
    [part='tooltip'] {
      position: fixed;
      z-index: 1000;
      max-width: 240px;
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
      transition: opacity var(--mndw-duration-fast) var(--mndw-easing);
    }

    :host([open]) [part='tooltip'] {
      opacity: 1;
    }
  `;

  declare public text: string;
  declare public placement: MndwTooltipPlacement;
  declare public delay: number;
  declare private visible: boolean;

  private readonly observer: MutationObserver;
  private trigger: Element | null = null;
  private ownedToken: string | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedExtras = false;

  constructor() {
    super();
    this.text = '';
    this.placement = 'top';
    this.delay = DEFAULT_DELAY;
    this.visible = false;
    this.observer = new MutationObserver(this.onMutations);
    // Keydown bubbles, so the host sees it whenever focus is inside the trigger. Hover and focus
    // are bound to the trigger itself in `wireTrigger`: `pointerenter` does not bubble, and this
    // host is `display: contents`, so relying on it being in the entered ancestor chain would be
    // relying on a subtlety.
    this.addEventListener('keydown', this.onKeyDown);
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
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancelShow();
    this.observer.disconnect();
    this.releaseTrigger();
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
        trigger.addEventListener('pointerenter', this.onShowIntent);
        trigger.addEventListener('focusin', this.onShowIntent);
        trigger.addEventListener('pointerleave', this.onHideIntent);
        trigger.addEventListener('focusout', this.onHideIntent);
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
      trigger.removeEventListener('pointerenter', this.onShowIntent);
      trigger.removeEventListener('focusin', this.onShowIntent);
      trigger.removeEventListener('pointerleave', this.onHideIntent);
      trigger.removeEventListener('focusout', this.onHideIntent);
    }

    if (trigger && this.ownedToken !== null) {
      this.writeTokens(trigger, tokensOf(trigger).filter((token) => token !== this.ownedToken));
    }

    this.ownedToken = null;
    this.trigger = null;
  }

  private readonly onMutations = (): void => {
    this.requestUpdate();
  };

  private readonly onShowIntent = (): void => {
    if (!this.text || this.visible || this.showTimer !== null) {
      return;
    }

    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.show();
    }, Math.max(this.delay, 0));
  };

  private readonly onHideIntent = (): void => {
    this.cancelShow();
    this.hide();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Dismissal only: the key belongs to whatever else is listening, such as a dialog.
    if (event.key === 'Escape') {
      this.onHideIntent();
    }
  };

  private cancelShow(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  private show(): void {
    if (!this.text || !this.isConnected) {
      return;
    }

    this.visible = true;
    this.position();
  }

  private hide(): void {
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
