import {LitElement, type PropertyDeclarations, css, html} from 'lit';
import {focusRing, hostTypography} from '../styles/base.js';

export const MNDW_CHECKBOX_TAG = 'mndw-checkbox';

export interface MndwCheckboxChangeDetail {
  checked: boolean;
}

export class MndwCheckbox extends LitElement {
  public static readonly formAssociated = true;

  public static readonly properties: PropertyDeclarations = {
    checked: {type: Boolean, reflect: true},
    indeterminate: {type: Boolean, reflect: true},
    disabled: {type: Boolean, reflect: true},
    value: {type: String, reflect: true},
    name: {type: String, reflect: true},
  };

  public static override readonly styles = [
    hostTypography,
    focusRing,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--mndw-space-2);
        color: var(--mndw-text);
        cursor: pointer;
        user-select: none;
      }

      :host([disabled]) {
        color: var(--mndw-text-muted);
        cursor: not-allowed;
        opacity: 0.65;
      }

      [part='label'] {
        cursor: pointer;
      }

      :host([disabled]) [part='label'] {
        cursor: not-allowed;
      }

      [part='box'] {
        display: inline-grid;
        width: 18px;
        height: 18px;
        place-items: center;
        border: 1px solid var(--mndw-border);
        border-radius: var(--mndw-radius-sm);
        background: var(--mndw-surface);
        color: var(--mndw-accent-contrast);
        flex: 0 0 auto;
      }

      [part='box'][aria-checked='true'],
      [part='box'][aria-checked='mixed'] {
        border-color: var(--mndw-accent);
        background: var(--mndw-accent);
      }

      [part='mark'] {
        display: none;
        font-size: var(--mndw-text-md);
        font-weight: var(--mndw-weight-semibold);
        line-height: var(--mndw-leading);
      }

      [part='box'][aria-checked='true'] [part='mark'] {
        display: block;
      }

      [part='box'][aria-checked='mixed'] [part='mark'] {
        display: block;
        width: 9px;
        height: 2px;
        background: currentColor;
        font-size: 0;
      }

      :host(:focus-visible) {
        outline: none;
      }
    `,
  ];

  declare public checked: boolean;
  declare public indeterminate: boolean;
  declare public disabled: boolean;
  declare public value: string;
  declare public name: string;

  private readonly internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null;

  constructor() {
    super();
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.value = 'on';
    this.name = '';
    this.addEventListener('click', this.handleClick);
    this.addEventListener('keydown', this.handleKeyDown);
  }

  protected override render(): unknown {
    const ariaChecked = this.indeterminate ? 'mixed' : String(this.checked);

    return html`
      <div
        part="box"
        role="checkbox"
        tabindex=${this.disabled ? '-1' : '0'}
        aria-checked=${ariaChecked}
        aria-disabled=${this.disabled ? 'true' : 'false'}
        @keydown=${this.handleKeyDown}
      >
        <span part="mark">✓</span>
      </div>
      <slot part="label"></slot>
    `;
  }

  protected override updated(): void {
    const ariaChecked = this.indeterminate ? 'mixed' : String(this.checked);

    if (this.internals) {
      this.internals.ariaChecked = ariaChecked;
      this.internals.setFormValue(this.checked ? this.value : null);

      if (this.checked) {
        this.internals.states.add('checked');
      } else {
        this.internals.states.delete('checked');
      }
    }
  }

  private readonly handleClick = (event: Event): void => {
    if (this.disabled) {
      event.preventDefault();

      return;
    }

    this.toggle();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled || (event.key !== ' ' && event.key !== 'Enter')) {
      return;
    }

    event.preventDefault();
    this.toggle();
  };

  private toggle(): void {
    this.indeterminate = false;
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent<MndwCheckboxChangeDetail>('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: this.checked},
      }),
    );
  }
}
