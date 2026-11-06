import {LitElement, type PropertyDeclarations, type TemplateResult, css, html} from 'lit';
import {controlBase, hostTypography, textHover} from '../styles/base.js';

export const MNDW_TAB_TAG = 'mndw-tab';

/**
 * One tab inside `<mndw-tabs>`. It owns no selection state and emits no change of its own:
 * activation bubbles to the group, which owns `value` and writes every ARIA relationship onto
 * this element.
 */
export class MndwTab extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    disabled: {type: Boolean, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-flex;
      cursor: pointer;
      user-select: none;
    }

    :host([aria-disabled='true']) {
      cursor: not-allowed;
      opacity: 0.5;
    }

    :host(:focus-visible) {
      outline: none;
    }

    [part='tab'] {
      ${controlBase}

      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-bottom: 2px solid transparent;
      border-radius: var(--mndw-radius-sm) var(--mndw-radius-sm) 0 0;
      color: var(--mndw-text-subtle);
      white-space: nowrap;
      transition: color var(--mndw-duration-fast) var(--mndw-easing);
    }

    :host(:focus-visible) [part='tab'] {
      outline: var(--mndw-focus-w) solid var(--mndw-focus-ring);
      outline-offset: -0.0625rem;
    }

    :host([aria-selected='true']) [part='tab'] {
      border-bottom-color: var(--mndw-accent);
      color: var(--mndw-text);
      font-weight: var(--mndw-weight-semibold);
    }

    :host(:not([disabled]):not([aria-disabled='true']):hover) [part='tab'] {
      ${textHover}
    }
  `;

  declare public disabled: boolean;

  constructor() {
    super();
    this.disabled = false;
  }

  public override connectedCallback(): void {
    super.connectedCallback();

    // The pairing runs the other way round, and the silent version of this mistake is a tab that
    // controls nothing.
    if (this.hasAttribute('for')) {
      console.warn(
        `<${MNDW_TAB_TAG} id="${this.id}"> has a "for" attribute; the panel points at its tab, `
          + 'so put "for" on the <mndw-tab-panel> instead.',
      );
    }
  }

  protected override render(): TemplateResult {
    return html`
      <span part="tab">
        <slot></slot>
      </span>
    `;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-tab': MndwTab;
  }
}
