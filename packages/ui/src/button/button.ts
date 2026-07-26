import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {controlBase, focusRing, hostTypography} from '../styles/base.js';

export const MNDW_BUTTON_TAG = 'mndw-button';

export type MndwButtonVariant = 'primary' | 'secondary' | 'ghost';

export class MndwButton extends LitElement {
  public static properties: PropertyDeclarations = {
    variant: {type: String, reflect: true},
    disabled: {type: Boolean, reflect: true},
    type: {type: String},
  };

  public static styles = css`
    :host {
      ${hostTypography}

      display: inline-block;
    }

    :host([disabled]) {
      pointer-events: none;
      opacity: 0.5;
    }

    button {
      ${controlBase}

      display: inline-flex;
      gap: var(--mndw-space-2);
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      font-weight: var(--mndw-weight-semibold);
      cursor: pointer;
    }

    button:focus-visible {
      ${focusRing}
    }

    :host([variant='primary']) button {
      border-color: var(--mndw-accent);
      background: var(--mndw-accent);
      color: var(--mndw-accent-contrast);
    }

    :host([variant='primary']) button:hover {
      border-color: var(--mndw-accent-hover);
      background: var(--mndw-accent-hover);
    }

    :host([variant='secondary']) button {
      border-color: var(--mndw-border);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
    }

    :host([variant='ghost']) button {
      background: transparent;
      color: var(--mndw-text-subtle);
    }

    :host([variant='ghost']) button:hover {
      background: color-mix(in srgb, var(--mndw-text) 8%, transparent);
      color: var(--mndw-text);
    }
  `;

  declare public variant: MndwButtonVariant;
  declare public disabled: boolean;
  declare public type: 'button' | 'submit';

  constructor() {
    super();

    this.variant = 'secondary';
    this.disabled = false;
    this.type = 'button';
  }

  protected render(): TemplateResult {
    return html`
      <button part="button" type=${this.type} ?disabled=${this.disabled}>
        <slot></slot>
      </button>
    `;
  }
}
