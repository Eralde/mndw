import {LitElement, type PropertyDeclarations, type PropertyValues, type TemplateResult, css, html} from 'lit';
import {controlBase, controlHover, hostTypography, textHover} from '../styles/base.js';

export const MNDW_SEGMENT_TAG = 'mndw-segment';
export const MNDW_SEGMENT_CHANGE_EVENT = 'mndwsegmentchange';

/**
 * One choice inside `<mndw-segmented>`. It owns no value state and emits no change of its own:
 * activation bubbles to the group, which owns the value, the form state, and the ARIA
 * relationships written onto this element.
 */
export class MndwSegment extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    value: {type: String, reflect: true},
    disabled: {type: Boolean, reflect: true},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}

      display: inline-flex;
      cursor: pointer;
      user-select: none;
    }

    :host([disabled]) {
      cursor: not-allowed;
      opacity: 0.5;
    }

    :host(:focus-visible) {
      outline: none;
    }

    [part='segment'] {
      ${controlBase}

      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--mndw-radius-sm);
      color: var(--mndw-text-subtle);
      white-space: nowrap;
      transition: background var(--mndw-duration-fast) var(--mndw-easing);
    }

    :host([aria-checked='true']) [part='segment'] {
      background: var(--mndw-accent);
      color: var(--mndw-accent-contrast);
      font-weight: var(--mndw-weight-semibold);
    }

    :host([aria-checked='false']:not([disabled]):not([aria-disabled='true']):hover) [part='segment'] {
      ${controlHover}
      ${textHover}
    }

    :host([aria-checked='true']:not([disabled]):not([aria-disabled='true']):hover) [part='segment'] {
      background: var(--mndw-accent-hover);
      color: var(--mndw-accent-contrast);
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
      <span part="segment">
        <slot></slot>
      </span>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    // The group cannot see a child property change; announcing is what keeps its wiring current.
    const announces = ['value', 'disabled'].some((name) => changed.has(name) && changed.get(name) !== undefined);

    if (announces) {
      this.dispatchEvent(new CustomEvent(MNDW_SEGMENT_CHANGE_EVENT, {bubbles: true, composed: false}));
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-segment': MndwSegment;
  }
}
