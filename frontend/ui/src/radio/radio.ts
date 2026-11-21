import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html} from 'lit';
import {accentHover, focusRing, hostTypography, surfaceHover} from '../styles/base.js';

export const MNDW_RADIO_TAG = 'mndw-radio';
export const MNDW_RADIO_CHANGE_EVENT = 'mndwradiochange';

/**
 * One choice inside `<mndw-radio-group>`. It owns no selection state: the group owns the value,
 * the form state, and the ARIA relationships written onto this element.
 */
export class MndwRadio extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    value: {type: String, reflect: true},
    disabled: {type: Boolean, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-flex;
      align-items: center;
      gap: var(--_mndw-radio-label-gap, var(--mndw-space-2));
      color: var(--mndw-text);
      cursor: pointer;
      user-select: none;
    }

    :host([disabled]),
    :host([aria-disabled='true']) {
      cursor: not-allowed;
      pointer-events: none;
    }

    :host([disabled]) {
      color: var(--mndw-text-muted);
      opacity: 0.65;
    }

    [part='label'] {
      cursor: pointer;
    }

    :host([disabled]) [part='label'],
    :host([aria-disabled='true']) [part='label'] {
      cursor: not-allowed;
    }

    [part='circle'] {
      position: relative;
      display: inline-grid;
      width: var(--_mndw-radio-indicator-size, 1.125rem);
      height: var(--_mndw-radio-indicator-size, 1.125rem);
      place-items: center;
      border: 1px solid var(--mndw-border);
      border-radius: 50%;
      background: var(--mndw-surface);
      flex: 0 0 auto;
    }

    :host([aria-checked='true']) [part='circle'] {
      border-color: var(--mndw-accent);
      background: var(--mndw-accent);
    }

    :host(:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true']):hover) [part='circle'] {
      ${surfaceHover}
    }

    :host([aria-checked='true']:not([disabled]):not([aria-disabled='true']):not([invalid]):not([aria-invalid='true']):hover) [part='circle'] {
      ${accentHover}
    }

    [part='dot'] {
      display: block;
      width: 50%;
      height: 50%;
      border-radius: 50%;
      background: var(--mndw-accent-contrast);
      visibility: hidden;
    }

    :host([aria-checked='true']) [part='dot'] {
      visibility: visible;
    }

    :host(:focus-visible) {
      outline: none;
    }

    :host(:focus-visible) [part='circle'] {
      ${focusRing}
    }
  `;

  declare public value: string;
  declare public disabled: boolean;

  constructor() {
    super();
    this.value = '';
    this.disabled = false;
  }

  protected override render(): TemplateResult {
    return html`
      <span part="circle" aria-hidden="true">
        <span part="dot"></span>
      </span>
      <slot part="label"></slot>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    // The group cannot see a child property change; announcing is what keeps its wiring current.
    const announces = ['value', 'disabled'].some((name) => changed.has(name) && changed.get(name) !== undefined);

    if (announces) {
      this.dispatchEvent(new CustomEvent(MNDW_RADIO_CHANGE_EVENT, {bubbles: true, composed: false}));
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-radio': MndwRadio;
  }
}
